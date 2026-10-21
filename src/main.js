import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadZombieTemplate, Zombie, makeZombieSkin } from './zombie.js';
import { generateMap } from './logic/mapgen.js';
import { buildNavGrid, nearestFree } from './logic/nav.js';
import { collideCircle } from './logic/collision.js';
import { buildMap } from './map.js';
import { Effects } from './effects.js';
import { WEAPONS, WEAPON_ORDER, createAmmo, canFire, fireShot, startReload, tickReload, tickCooldown, currentSpread, recoilStep, resetRecoil, lowAmmo } from './logic/weapons.js';
import { applyHit, makeCombatStats, scoreForKill } from './logic/damage.js';

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
viewCamera.add(new THREE.PointLight(0xbfd4ff, 30, 6).translateX(0.4).translateY(0.6).translateZ(0.4));
viewScene.add(new THREE.AmbientLight(0x667788, 2.5));

const moon = new THREE.DirectionalLight(0x8fa8ff, 1.0);
moon.position.set(-30, 45, -20);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
const SH = 55;
Object.assign(moon.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, far: 160 });
scene.add(moon);
scene.add(new THREE.AmbientLight(0x223044, 1.0));
scene.add(new THREE.HemisphereLight(0x334466, 0x0a0a10, 0.5));
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.6);
fill.position.set(6, 8, 18);
scene.add(fill);
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16), new THREE.MeshBasicMaterial({ color: 0xdde6ff }));
moonMesh.position.set(-120, 90, -160);
scene.add(moonMesh);

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const ASSET = 'assets/characters-survivors/';
const BLASTER = 'assets/blaster-kit/Models/GLB%20format/';

const map = generateMap(1337);
const navGrid = buildNavGrid(map);
let mapWorld = null;
const zombies = [];
let zombieTemplate = null, skinA = null, skinC = null;
const fx = new Effects(scene);

// raycast world (invisible boxes for colliders)
const worldRayGroup = new THREE.Group();
scene.add(worldRayGroup);
const rayBoxGeo = new THREE.BoxGeometry(1, 1, 1);
const rayBoxMat = new THREE.MeshBasicMaterial();
let worldRayboxes = [];
function rebuildWorldRay() {
  for (const m of worldRayboxes) worldRayGroup.remove(m);
  worldRayboxes = [];
  const all = mapWorld ? [...mapWorld.colliders, ...mapWorld.fenceColliders] : [];
  for (const b of all) {
    const m = new THREE.Mesh(rayBoxGeo, rayBoxMat);
    m.position.set(b.x, b.h / 2, b.z);
    m.scale.set(b.hw * 2, b.h, b.hd * 2);
    m.userData.surface = b.kind === 'fence' ? 'wood' : (b.kind === 'tree' ? 'wood' : 'dust');
    m.visible = false;
    worldRayGroup.add(m); worldRayboxes.push(m);
  }
}

async function loadAssets() {
  zombieTemplate = await loadZombieTemplate(FBXLoader, ASSET);
  skinA = makeZombieSkin(texLoader, ASSET + 'Skins/zombieA.png');
  skinC = makeZombieSkin(texLoader, ASSET + 'Skins/zombieC.png');
  mapWorld = await buildMap(scene, map, gltfLoader);
  rebuildWorldRay();
  const guns = {};
  await Promise.all(WEAPON_ORDER.map(async id => {
    console.log('[gun]', id);
    guns[id] = (await gltfLoader.loadAsync(BLASTER + WEAPONS[id].model + '.glb')).scene;
  }));
  const clip = (await gltfLoader.loadAsync(BLASTER + 'clip-small.glb')).scene;
  const foam = (await gltfLoader.loadAsync(BLASTER + 'bullet-foam.glb')).scene;
  console.log('[assets] all loaded');
  return { guns, clip, foam };
}

function spawnZombie(x, z, skin, opts = {}) {
  const zom = new Zombie(zombieTemplate, skin, opts);
  zom.root.position.set(x, 0, z);
  zom.stats = makeCombatStats(opts.hp || 100);
  zom.speedMul = opts.speed || 1;
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
  dip: 0, swap: 0, swapTo: null, guns: {}, holder: null, clipMesh: null, clipState: 0,
};
function fitGun(gun) {
  gun.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(gun);
  const size = new THREE.Vector3(); box.getSize(size);
  gun.scale.setScalar(0.26 / Math.max(size.x, size.y, size.z));
  const c = new THREE.Vector3(); box.getCenter(c);
  gun.position.sub(c);
  const holder = new THREE.Group(); holder.add(gun);
  return holder;
}
function setupViewModel(guns, clipModel) {
  for (const id of WEAPON_ORDER) vm.guns[id] = fitGun(guns[id]);
  vm.clipProto = clipModel;
  viewCamera.add(vm.group);
  vm.pos.copy(vm.base); vm.group.position.copy(vm.base);
  setGunVisual('rifle');
}
function setGunVisual(id) {
  if (vm.holder) vm.group.remove(vm.holder);
  vm.holder = vm.guns[id];
  vm.group.add(vm.holder);
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
  const d2 = new THREE.Vector3().subVectors(to, from); const len = Math.max(0.5, d2.length());
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
  recoilPitch: 0, recoilYaw: 0, heat: 0, shake: 0,
};
const keys = {};
let mouseDX = 0, mouseDY = 0, firing = false, aiming = false;
addEventListener('keydown', e => { keys[e.code] = true; onKey(e.code); });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousemove', e => { if (document.pointerLockElement) { mouseDX += e.movementX; mouseDY += e.movementY; } });
addEventListener('mousedown', e => { if (e.button === 0) firing = true; if (e.button === 2) aiming = true; });
addEventListener('mouseup', e => { if (e.button === 0) firing = false; if (e.button === 2) aiming = false; });
addEventListener('wheel', e => { if (document.pointerLockElement) switchWeapon(WEAPON_ORDER[(curWeaponIdx() + (e.deltaY > 0 ? 1 : 3)) % 4]); });
addEventListener('contextmenu', e => e.preventDefault());

// ---------- weapons state ----------
const ammoStates = {};
for (const id of WEAPON_ORDER) ammoStates[id] = createAmmo(id, true);
let curWeapon = 'rifle';
function curWeaponIdx() { return WEAPON_ORDER.indexOf(curWeapon); }
function onKey(code) {
  if (code === 'KeyR') tryReload();
  const n = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 }[code];
  if (n !== undefined) switchWeapon(WEAPON_ORDER[n]);
}
function switchWeapon(id) {
  if (id === curWeapon || !ammoStates[id].owned) return;
  curWeapon = id;
  vm.swap = 1; vm.swapTo = id;
  resetRecoil(ammoStates[id]);
  updateHudWeapon();
}
function tryReload() {
  const a = ammoStates[curWeapon];
  if (startReload(a)) {
    vm.clipState = 1; vm.clipDrop = 0;
    document.getElementById('reloadTxt').style.opacity = 1;
  }
}

// ---------- combat ----------
const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();
let hitstop = 0, slowmo = 1;
let kills = 0, score = 0, combo = 0, comboTimer = 0, streakCount = 0, streakTimer = 0;
let lastKillTime = -10;
const dmgNums = [];

function allHitSpheres() {
  const arr = [];
  for (const z of zombies) if (z.stats.alive) for (const s of z.hitSpheres) arr.push(s);
  return arr;
}

function surfaceOf(obj) { return obj.userData.surface || 'dust'; }

function fire() {
  const a = ammoStates[curWeapon];
  const w = WEAPONS[curWeapon];
  if (!canFire(a, 0)) {
    if (a.clip === 0 && !a.reloading) { audio.emptyClick(lowAmmo(a)); tryReload(); }
    return;
  }
  fireShot(a);
  a.heat = Math.min(10, a.heat + 1);
  const rec = recoilStep(a);
  player.recoilPitch += rec.pitch; player.recoilYaw += rec.yaw;
  player.shake = Math.max(player.shake, w.shake);
  vm.kick = w.kick; vm.kickRot = w.kick * 0.6;
  audio.shot(curWeapon);
  if (a.clip === 0) audio.dry();

  const origin = camera.position.clone();
  const spread = currentSpread(a, { moving: playerMoving, aiming, heat: a.heat });
  const maxPen = w.penetration;
  const pellets = w.pellets;
  const spheres = allHitSpheres();

  for (let p = 0; p < pellets; p++) {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
    dir.x += (Math.random() - 0.5) * spread * 2;
    dir.y += (Math.random() - 0.5) * spread * 2;
    dir.z += (Math.random() - 0.5) * spread * 2;
    dir.normalize();
    raycaster.set(origin, dir);
    raycaster.far = 120;
    const zHits = raycaster.intersectObjects(spheres, false);
    const wHits = raycaster.intersectObjects(worldRayboxes, false);
    const hits = [...zHits, ...wHits].sort((x, y) => x.distance - y.distance);
    let end = origin.clone().addScaledVector(dir, 80);
    let pen = 0;
    const hitZombies = new Set();
    for (const h of hits) {
      if (h.object.userData.zombie) {
        const zom = h.object.userData.zombie;
        if (hitZombies.has(zom.id)) continue;
        hitZombies.add(zom.id);
        end = h.point.clone();
        hitZombie(zom, h.object.userData.zone, dir, w);
        pen++;
        if (pen > maxPen) break;
      } else {
        end = h.point.clone();
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        const surf = surfaceOf(h.object);
        fx.burst(h.point, surf, n.clone().negate());
        if (surf !== 'spark') fx.decal(h.point, n);
        break;
      }
    }
    fireEffects(muzzleWorldPos(), end);
  }
  // shell eject
  const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
  const up = new THREE.Vector3(0, 1, 0).applyEuler(camera.rotation);
  fx.shell(camera.position.clone().addScaledVector(right, 0.25).addScaledVector(up, -0.1).addScaledVector(dir0(), 0.3), right, up);
  updateHudAmmo();
}
function dir0() { return new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation); }
function muzzleWorldPos() {
  return camera.position.clone().addScaledVector(new THREE.Vector3(0.2, -0.1, -0.4).applyEuler(camera.rotation), 1);
}

function hitZombie(zom, zone, dir, w) {
  const res = applyHit(zom.stats, w, zone);
  zom.flashT = 0.08;
  fx.burst(zom.hitSpheres.find(s => s.userData.zone === zone)?.getWorldPosition(tmpV) || zom.root.position, 'goo', dir);
  spawnDmgNum(zom.root.position.clone().setY(1.8), Math.round(res.damage), zone === 'head');
  audio.hit();
  if (zone === 'head') showHitmarker('head'); else showHitmarker('hit');
  if (res.becameCrawler) { zom.setCrawl(true); zom.a.knockTarget = 0; }
  if (w.knockdown && zone !== 'legs') zom.knockdown();
  // knockback in shot direction
  if (zom.stats.alive) {
    zom.kb = (zom.kb || 0) + w.knockback * (zone === 'legs' ? 0.4 : 1);
    zom.kbDir = Math.atan2(dir.x, dir.z);
  }
  if (res.dead) onZombieDeath(zom, zone, dir);
  else {
    if (zone === 'head') zom.flinch('head');
    else if (zone === 'legs') zom.flinch('leg', Math.random() < 0.5 ? -1 : 1);
    else zom.flinch('body', Math.random() * 2 - 1);
    zom.interruptAttack();
  }
}

function onZombieDeath(zom, zone, dir) {
  kills++;
  combo++; comboTimer = 3; streakCount++; streakTimer = 1.2;
  score += scoreForKill(WEAPONS[curWeapon], zone, combo);
  const fallYaw = Math.atan2(dir.x, dir.z);
  zom.die(fallYaw);
  showHitmarker('kill');
  if (zone === 'head') {
    showHeadshot();
    hitstop = 0.04;
  }
  if (streakCount >= 2 && streakTimer > 0) showStreak(streakCount);
  audio.kill();
  updateHudTop();
}

// ---------- HUD ----------
const $ = id => document.getElementById(id);
function updateHudAmmo() {
  const a = ammoStates[curWeapon];
  $('ammoClip').textContent = a.clip;
  $('ammoReserve').textContent = '/ ' + a.reserve;
  const spread = currentSpread(a, { moving: playerMoving, aiming, heat: a.heat });
  buildCrosshair(spread);
}
function updateHudWeapon() {
  $('weaponName').textContent = WEAPONS[curWeapon].name;
  const slots = $('wslots'); slots.innerHTML = '';
  for (const id of WEAPON_ORDER) {
    const d = document.createElement('div');
    d.className = 'wslot' + (id === curWeapon ? ' cur' : '') + (ammoStates[id].owned ? '' : ' locked');
    d.textContent = WEAPONS[id].slot + ' ' + WEAPONS[id].name;
    slots.appendChild(d);
  }
  updateHudAmmo();
}
function updateHudTop() {
  $('killsVal').textContent = kills;
  $('scoreVal').textContent = score;
  $('comboTag').textContent = combo > 1 ? `SCORE x${(1 + Math.min(combo, 10) * 0.1).toFixed(1)}` : 'SCORE';
}
function buildCrosshair(spread) {
  const gap = 6 + spread * 900;
  const ch = $('crosshair');
  if (!ch.built) {
    for (let i = 0; i < 4; i++) { const d = document.createElement('div'); d.className = 'ch'; ch.appendChild(d); }
    ch.built = true;
  }
  const [t, b, l, r] = ch.children;
  t.style.cssText += `;width:2px;height:8px;left:-1px;top:${-gap - 8}px`;
  b.style.cssText += `;width:2px;height:8px;left:-1px;top:${gap}px`;
  l.style.cssText += `;width:8px;height:2px;top:-1px;left:${-gap - 8}px`;
  r.style.cssText += `;width:8px;height:2px;top:-1px;left:${gap}px`;
}
let hmTimer = 0;
function showHitmarker(kind) {
  const hm = $('hitmarker');
  hm.className = kind;
  hm.textContent = kind === 'kill' ? '✕' : '+';
  hm.style.opacity = 1; hmTimer = 0.25;
}
let hsTimer = 0;
function showHeadshot() { $('headshotTxt').style.opacity = 1; hsTimer = 0.8; }
let stTimer = 0;
function showStreak(n) {
  $('streakTxt').textContent = n === 2 ? 'DOUBLE KILL' : n === 3 ? 'TRIPLE KILL' : n + 'x MULTI KILL';
  $('streakTxt').style.opacity = 1; stTimer = 1.2;
}
function spawnDmgNum(worldPos, dmg, head) {
  const d = document.createElement('div');
  d.className = 'dmgnum' + (head ? ' head' : '');
  d.textContent = dmg;
  document.body.appendChild(d);
  dmgNums.push({ el: d, pos: worldPos.clone(), life: 0.8, vy: 1.2 });
}

// ---------- audio stubs (full synth in stage 6) ----------
const audio = {
  ctx: null, muted: false,
  ensure() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; },
  blip(freq, dur, type = 'square', vol = 0.08) {
    if (this.muted) return;
    try {
      const c = this.ensure(); const o = c.createOscillator(); const g = c.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = vol;
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + dur);
    } catch (e) {}
  },
  shot(id) { this.blip(id === 'shotgun' ? 90 : id === 'rifle' ? 160 : 220, 0.09, 'sawtooth', 0.12); },
  dry() { this.blip(900, 0.04, 'square', 0.05); },
  emptyClick() { this.blip(700, 0.03, 'square', 0.04); },
  hit() { this.blip(500, 0.05, 'triangle', 0.06); },
  kill() { this.blip(300, 0.12, 'triangle', 0.07); },
  reload() { this.blip(400, 0.06, 'square', 0.05); },
};

// ---------- input / player ----------
let playerMoving = false;
function collidersNow() { return mapWorld ? [...mapWorld.colliders, ...mapWorld.fenceColliders] : []; }
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
  playerMoving = wish.lengthSq() > 0;
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
  player.vel.x = wish.x; player.vel.z = wish.z;
  if (keys.Space && player.onGround) { player.vel.y = 5.2; player.onGround = false; }
  player.vel.y -= 14 * dt;
  let nx = player.pos.x + player.vel.x * dt, nz = player.pos.z + player.vel.z * dt;
  const res = collideCircle(nx, nz, player.radius, collidersNow());
  nx = Math.max(-58, Math.min(58, res.x)); nz = Math.max(-58, Math.min(58, res.z));
  player.pos.x = nx; player.pos.z = nz;
  player.pos.y += player.vel.y * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vel.y = 0; player.onGround = true; }

  // recoil recovery
  player.recoilPitch *= Math.max(0, 1 - dt * 6);
  player.recoilYaw *= Math.max(0, 1 - dt * 6);
  player.shake = Math.max(0, player.shake - dt * 4);
  player.eye = 1.6 - player.crouch * 0.6;
  const shx = (Math.random() - 0.5) * player.shake * 0.02;
  const shy = (Math.random() - 0.5) * player.shake * 0.02;
  camera.position.set(player.pos.x, player.pos.y + player.eye + shy, player.pos.z);
  camera.rotation.set(player.pitch + player.recoilPitch, player.yaw + player.recoilYaw + shx, 0, 'YXZ');
  return playerMoving;
}

// ---------- demo ----------
let demoMode = DEMO;
if (DEMO) document.getElementById('startScreen').classList.remove('on');

async function init() {
  const { guns, clip, foam } = await loadAssets();
  setupViewModel(guns, clip);
  if (VIEW === 'map') {
    scene.fog = null; moon.intensity = 3.5; fill.intensity = 2.5;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    vm.group.visible = false;
    camera.position.set(0, 70, 0.01); camera.rotation.set(-Math.PI / 2, 0, 0);
  } else {
    const [sx, sz] = nearestFree(navGrid, 0, 8);
    player.pos.set(sx, 0, sz);
    if (VIEW === 'zombies') player.pos.set(0, 0, 0.5);
    player.yaw = 0; player.pitch = -0.05;
    $('hud').classList.add('on');
    updateHudWeapon(); updateHudTop();
  }

  const zbase = VIEW === 'zombies' ? -2.6 : -4;
  if (ANIM) {
    for (let i = 0; i < 5; i++) {
      const z = spawnZombie((i - 2) * 1.3, zbase, i % 2 ? skinA : skinC);
      z.root.rotation.y = Math.PI;
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
      z.root.rotation.y = Math.PI; z.setMove(1);
    }
  }
  if (VIEW === 'fire') {
    // keep zombies alive for continuous target practice
    for (const z of zombies) { z.stats.alive = true; z.a.death = null; }
  }
  console.log('[main] ready'); window.__gameReady = true;
}
init().catch(e => console.error('[init failed]', e && e.stack || e));

// ---------- loop ----------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  let dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (hitstop > 0) { hitstop -= dt; dt = 0.0001; }
  dt *= slowmo;

  let moving = false;
  if (VIEW !== 'map') moving = updatePlayer(dt);

  // firing
  const w = WEAPONS[curWeapon];
  if (VIEW === 'fire' && t - lastDemoShot > 0.15) { lastDemoShot = t; demoFire(); }
  if (firing && !demoMode && (w.auto || !lastFireHeld)) {
    if (w.auto || !firedOnce) { fire(); firedOnce = true; }
  }
  if (!firing) firedOnce = false;
  lastFireHeld = firing;

  // reload tick + view anim
  const a = ammoStates[curWeapon];
  a.heat = Math.max(0, a.heat - dt * 4);
  if (tickReload(a, dt)) {
    document.getElementById('reloadTxt').style.opacity = 0;
    vm.clipState = 0; audio.reload(); updateHudAmmo();
  }
  if (a.reloading) vm.dip = Math.min(1, vm.dip + dt * 6); else vm.dip = Math.max(0, vm.dip - dt * 6);

  // weapon swap anim
  if (vm.swap > 0) {
    vm.swap -= dt * 4;
    if (vm.swap <= 0.5 && vm.swapTo) { setGunVisual(vm.swapTo); vm.swapTo = null; }
    if (vm.swap < 0) vm.swap = 0;
  }

  // ADS
  const adsTarget = aiming ? 1 : 0;
  vm.adsAmt += (adsTarget - vm.adsAmt) * Math.min(1, dt * 10);
  camera.fov = 75 - (WEAPONS[curWeapon].scope ? 45 : 20) * vm.adsAmt;
  camera.updateProjectionMatrix();
  $('scopeOverlay').classList.toggle('on', WEAPONS[curWeapon].scope && vm.adsAmt > 0.9);

  // view model transform
  vm.bobT += dt * (moving ? 8 : 3);
  vm.bob = Math.sin(vm.bobT) * (moving ? 0.012 : 0.004);
  vm.kick = Math.max(0, vm.kick - dt * 6);
  vm.kickRot = Math.max(0, vm.kickRot - dt * 6);
  const bp = vm.base.clone().lerp(vm.ads, vm.adsAmt);
  vm.pos.copy(bp);
  vm.pos.x += (vm.bob * 0.6 + vm.swayX) * (1 - vm.adsAmt);
  vm.pos.y += (Math.abs(Math.sin(vm.bobT)) * 0.008 + vm.swayY) * (1 - vm.adsAmt) - vm.kick * 0.06 - vm.dip * 0.25 - (vm.swap > 0.5 ? (1 - vm.swap) * 0.4 : vm.swap * 0.4);
  vm.pos.z += vm.kick * 0.09;
  vm.group.position.copy(vm.pos);
  if (vm.holder) vm.holder.rotation.set(vm.kickRot * 0.5 + vm.swayY * 0.5 * (1 - vm.adsAmt) + vm.dip * 0.5, vm.swayX * 0.8 * (1 - vm.adsAmt), 0);

  // flash / tracers
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
  for (const z of zombies) {
    if (z.kb > 0) {
      const d = new THREE.Vector3(Math.sin(z.kbDir), 0, Math.cos(z.kbDir));
      const nx = z.root.position.x + d.x * z.kb * dt * 2, nz = z.root.position.z + d.z * z.kb * dt * 2;
      const cr = collideCircle(nx, nz, 0.4, collidersNow());
      z.root.position.set(cr.x, 0, cr.z);
      z.kb = Math.max(0, z.kb - dt * 8);
    }
    z.update(dt);
  }
  fx.update(dt);
  scene.__camMat = camera.matrixWorld;

  // HUD timers
  if (hmTimer > 0) { hmTimer -= dt; if (hmTimer <= 0) $('hitmarker').style.opacity = 0; }
  if (hsTimer > 0) { hsTimer -= dt; if (hsTimer <= 0) $('headshotTxt').style.opacity = 0; }
  if (stTimer > 0) { stTimer -= dt; if (stTimer <= 0) $('streakTxt').style.opacity = 0; }
  if (comboTimer > 0) { comboTimer -= dt; if (comboTimer <= 0) { combo = 0; streakCount = 0; updateHudTop(); } }
  if (streakTimer > 0) { streakTimer -= dt; if (streakTimer <= 0) streakCount = 0; }
  $('healthFill').style.width = player.health + '%';
  $('staminaFill').style.width = player.stamina + '%';
  // damage numbers
  for (let i = dmgNums.length - 1; i >= 0; i--) {
    const d = dmgNums[i];
    d.life -= dt; d.pos.y += d.vy * dt;
    if (d.life <= 0) { d.el.remove(); dmgNums.splice(i, 1); continue; }
    const v = d.pos.clone().project(camera);
    d.el.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
    d.el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    d.el.style.opacity = Math.min(1, d.life * 2);
  }

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(viewScene, viewCamera);
}
let firedOnce = false, lastFireHeld = false, lastDemoShot = 0;
function demoFire() {
  const zom = zombies.find(z => z.stats.alive);
  if (!zom) return;
  const from = camera.position.clone();
  const to = zom.root.position.clone().setY(1.2);
  fireEffects(muzzleWorldPos(), to);
  vm.kick = 0.7; vm.kickRot = 0.4;
  fx.burst(to, 'goo', new THREE.Vector3(0, 0, 1));
  zom.flashT = 0.08;
  zom.flinch('body', 0.6);
  spawnDmgNum(zom.root.position.clone().setY(1.9), 34, false);
  const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
  const up = new THREE.Vector3(0, 1, 0).applyEuler(camera.rotation);
  fx.shell(camera.position.clone().addScaledVector(right, 0.25).addScaledVector(up, -0.1), right, up);
}
loop();

addEventListener('resize', () => {
  camera.aspect = viewCamera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix(); viewCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
