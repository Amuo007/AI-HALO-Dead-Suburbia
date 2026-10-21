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
import { TYPES, typeStats } from './logic/types.js';
import { canSee, hears } from './logic/senses.js';
import { createAI, updateAI, onHit as aiOnHit, onKnockdown as aiOnKnock, onDead as aiOnDead, S } from './logic/zombieAI.js';
import { makeSlots, claimSlot, releaseSlot, slotPos, shouldFlank } from './logic/surround.js';
import { flowField, flowDir, cellOf } from './logic/nav.js';

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
  buildSightBoxes();
  rebuildFlow();
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
  const type = opts.type || 'walker';
  const ts = typeStats(type);
  const zom = new Zombie(zombieTemplate, skin, {
    tint: opts.tint !== undefined ? opts.tint : ts.tint,
    sizeMul: (opts.sizeMul || 1) * ts.size,
    hp: opts.hp || ts.hp,
  });
  zom.root.position.set(x, 0, z);
  zom.stats = makeCombatStats(opts.hp || ts.hp);
  zom.type = type;
  zom.ts = ts;
  zom.ai = createAI(type);
  zom.speedMul = ts.speed;
  zom.aiSlot = -1;
  scene.add(zom.root);
  zombies.push(zom);
  return zom;
}

// ---------- AI world ----------
const aiSlots = makeSlots();
let flowDist = null, flowTimer = 0;
const projectiles = [];
const puddles = [];
let hordeAlert = 0;

function rebuildFlow() {
  flowDist = flowField(navGrid, player.pos.x, player.pos.z);
}

function alertNearby(x, z, radius) {
  for (const z2 of zombies) {
    if (!z2.stats.alive) continue;
    const d = Math.hypot(z2.root.position.x - x, z2.root.position.z - z);
    if (d <= radius) {
      z2.ai.alerted = true;
      z2.stats.memX = player.pos.x; z2.stats.memZ = player.pos.z; z2.stats.memValid = true;
      if (z2.ai.state === S.IDLE || z2.ai.state === S.WANDER) { z2.ai.state = S.ALERT; z2.ai.t = 0; }
    }
  }
}

function noiseHeard(radius) {
  for (const z of zombies) {
    if (!z.stats.alive) continue;
    if (hears(z.root.position.x, z.root.position.z, player.pos.x, player.pos.z, radius)) {
      z.stats.memValid = true; z.stats.memX = player.pos.x; z.stats.memZ = player.pos.z;
      if (!z.ai.alerted && !canSee(z.root.position.x, z.root.position.z, z.root.rotation.y, player.pos.x, player.pos.z, sightBoxes)) {
        z.ai.alerted = true;
        if (z.ai.state === S.IDLE || z.ai.state === S.WANDER) { z.ai.state = S.INVESTIGATE; z.ai.t = 0; }
      }
    }
  }
}

let sightBoxes = [];
function buildSightBoxes() {
  sightBoxes = mapWorld ? mapWorld.colliders.filter(b => b.kind === 'house') : [];
}

let attackers = 0;
function updateZombieAI(z, dt, frame) {
  const ts = z.ts;
  const zp = z.root.position;
  const dx = player.pos.x - zp.x, dz = player.pos.z - zp.z;
  const dist = Math.hypot(dx, dz);
  const seen = z.stats.alive && canSee(zp.x, zp.z, z.root.rotation.y, player.pos.x, player.pos.z, sightBoxes, flashlightOn);
  if (seen) { z.stats.memValid = true; z.stats.memX = player.pos.x; z.stats.memZ = player.pos.z; }
  if (!z.stats.alive) { aiOnDead(z.ai); return; }

  // claim surround slot when alerted
  if (z.ai.alerted && z.aiSlot < 0 && dist < 25) {
    z.aiSlot = claimSlot(aiSlots, z.id, Math.atan2(zp.x - player.pos.x, zp.z - player.pos.z));
    z.ai.flanking = shouldFlank(z.id) && dist > 8;
  }
  if (!z.ai.alerted && z.aiSlot >= 0) { releaseSlot(aiSlots, z.id); z.aiSlot = -1; }
  const slot = z.aiSlot >= 0 ? slotPos(aiSlots, z.aiSlot, player.pos.x, player.pos.z, 1.6) : { x: 0, z: 0 };

  const flow = flowDist ? flowDir(navGrid, flowDist, zp.x, zp.z) : null;
  const ctx = {
    x: zp.x, z: zp.z, px: player.pos.x, pz: player.pos.z,
    dist, canSee: seen, memValid: z.stats.memValid, memX: z.stats.memX, memZ: z.stats.memZ,
    flow, attackRange: ts.attackRange, attackCd: ts.attackCd,
    attackToken: attackers < 3 + Math.floor(wave / 2),
    isCrawler: z.stats.crawler, knocked: z.a.knockTarget > 0.5,
    screamer: !!ts.scream, flanking: z.ai.flanking,
    slotX: slot.x, slotZ: slot.z,
  };
  const out = updateAI(z.ai, ctx, dt);
  if (out.scream) { audio.scream(); alertNearby(zp.x, zp.z, 40); hordeAlert = 2; }
  if (out.stuck && !seen) { respawnZombie(z); return; }

  // sync visual states
  if (z.ai.state === S.KNOCKDOWN) { z.knockdown(); aiOnKnock(z.ai); }
  else if (z.a.knockTarget > 0 && z.ai.state !== S.KNOCKDOWN) z.getUp();
  if (z.stats.crawler && !z.a.crawl) z.setCrawl(true);

  // spitter ranged behaviour
  if (ts.ranged && z.ai.state === S.CHASE && dist < ts.keepDist[1] && dist > ts.keepDist[0]) {
    out.moveX *= 0.3; out.moveZ *= 0.3;
    z.spitCd = (z.spitCd || 0) - dt;
    if (z.spitCd <= 0 && seen) { z.spitCd = 3; spitAt(z, player.pos); }
    // strafe
    const s = Math.sin(clock.elapsedTime * 1.5 + z.id);
    out.moveX += -dz / (dist || 1) * s * 0.6; out.moveZ += dx / (dist || 1) * s * 0.6;
  }
  // brute charge
  if (ts.charge && z.ai.state === S.CHASE && dist > 5) { out.speed = (out.speed || 1) * 1.8; if (Math.random() < dt * 0.15 && dist < 20) audio.roar(); }
  // runner zigzag when player aims at it
  if (ts.zigzag && dist < 18) {
    const camF = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
    const toZ = new THREE.Vector3(zp.x - camera.position.x, 0, zp.z - camera.position.z).normalize();
    if (camF.x * toZ.x + camF.z * toZ.z > 0.985) {
      const s = Math.sin(clock.elapsedTime * 6 + z.id * 2);
      out.moveX += -dz / (dist || 1) * s; out.moveZ += dx / (dist || 1) * s;
    }
  }

  // separation from other zombies
  let sepX = 0, sepZ = 0;
  for (const o of zombies) {
    if (o === z || !o.stats.alive) continue;
    const ox = zp.x - o.root.position.x, oz = zp.z - o.root.position.z;
    const d2 = ox * ox + oz * oz;
    if (d2 < 1.44 && d2 > 0.0001) { const d = Math.sqrt(d2); sepX += ox / d * 0.6; sepZ += oz / d * 0.6; }
  }

  const spd = (out.speed || 1) * ts.speed * (z.stats.slowed || 1) * (z.stats.armWeakened ? 1 : 1);
  z.stats.slowed = Math.min(1, (z.stats.slowed || 1) + dt * 0.1);
  let mx = out.moveX + sepX, mz = out.moveZ + sepZ;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  const moving = ml > 0.05 && z.ai.state !== S.KNOCKDOWN && z.ai.state !== S.ATTACK;
  if (moving) {
    const nx = zp.x + mx * spd * dt, nz = zp.z + mz * spd * dt;
    const cr = collideCircle(nx, nz, 0.4, [...mapWorld.colliders, ...mapWorld.fenceColliders]);
    // bash fences
    for (const fc of mapWorld.fenceColliders) {
      if (circleHitsBoxLocal(cr.x, cr.z, 0.45, fc)) {
        fc.fence.hp -= spd * dt * 40;
        fx.burst(new THREE.Vector3(fc.x, 0.8, fc.z), 'wood', new THREE.Vector3(0, 0.5, 0));
        if (fc.fence.hp <= 0) { mapWorld.removeFence(fc.fence); rebuildWorldRay(); audio.woodBreak(); }
        break;
      }
    }
    z.root.position.set(cr.x, 0, cr.z);
    const faceYaw = Math.atan2(mx, mz);
    let dy = faceYaw - z.root.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    z.root.rotation.y += dy * Math.min(1, dt * 5);
  }
  z.setMove(moving ? Math.min(1, spd) : 0);

  // attack lands at swipe hit moment
  if (out.wantAttack) z.startAttack();
  if (z.attackHitPending && dist < ts.attackRange * 1.3) {
    z.attackHitPending = false;
    if (ts.explode) { bloaterExplode(z); }
    else damagePlayer(ts.dmg * (z.stats.armWeakened ? 0.6 : 1), zp);
    if (ts.knockback) {
      const kb = new THREE.Vector3(player.pos.x - zp.x, 0, player.pos.z - zp.z).normalize().multiplyScalar(ts.knockback * 0.12);
      player.pos.x += kb.x; player.pos.z += kb.z;
      player.shake = 1.5;
    }
  }
  if (z.ai.state === S.ATTACK) attackers++;
  if (z.a.flinchT >= 0) aiOnHit(z.ai);
}

let crateProto = null;
function placeCrates() {
  if (!crateProto) return;
  const spots = [[-6, -20], [10, 16], [-30, 6], [34, -30], [-16, 40], [40, 22]];
  for (const [x, z] of spots) {
    const c = crateProto.clone(true);
    c.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.set(0xcc2222); o.material.emissive = new THREE.Color(0x440000); } });
    const [fx2, fz2] = nearestFree(navGrid, x, z);
    c.position.set(fx2, 0, fz2);
    scene.add(c);
    const box = new THREE.Mesh(rayBoxGeo, rayBoxMat);
    box.position.set(fx2, 0.6, fz2); box.scale.set(1.2, 1.2, 1.2); box.visible = false;
    box.userData.crate = { mesh: c, x: fx2, z: fz2 };
    worldRayGroup.add(box); worldRayboxes.push(box);
    crates.push(box);
  }
}

function circleHitsBoxLocal(x, z, r, b) {
  const qx = Math.max(-b.hw, Math.min(b.hw, x - b.x));
  const qz = Math.max(-b.hd, Math.min(b.hd, z - b.z));
  return (x - b.x - qx) ** 2 + (z - b.z - qz) ** 2 < r * r;
}

function respawnZombie(z) {
  z.ai.stuckT = 0;
  const sp = map.spawns[Math.floor(Math.random() * map.spawns.length)];
  const [fx2, fz2] = nearestFree(navGrid, sp.x, sp.z);
  z.root.position.set(fx2, 0, fz2);
}

function spitAt(z, target) {
  const g = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x54d13a, emissive: 0x1a5510 }));
  g.position.copy(z.root.position).setY(1.4);
  const v = new THREE.Vector3(target.x - z.root.position.x, 0, target.z - z.root.position.z);
  const t = v.length() / 8;
  v.normalize().multiplyScalar(v.length() / Math.max(0.4, t));
  v.y = 4.5;
  scene.add(g);
  projectiles.push({ m: g, vel: v, life: 4, kind: 'goo' });
  audio.spit();
}

function bloaterExplode(z) {
  const p = z.root.position.clone();
  fx.burst(p.clone().setY(1), 'goo', new THREE.Vector3(0, 1, 0));
  fx.burst(p.clone().setY(1), 'goo', new THREE.Vector3(0, 1, 0));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 1, 24),
    new THREE.MeshBasicMaterial({ color: 0x8aff5a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  ring.rotation.x = -Math.PI / 2; ring.position.copy(p).setY(0.1);
  scene.add(ring); shockwaves.push({ m: ring, life: 0.5 });
  audio.bloaterPop();
  const d = Math.hypot(player.pos.x - p.x, player.pos.z - p.z);
  if (d < 5) damagePlayer(40 * (1 - d / 5), p);
  for (const o of zombies) {
    if (o === z || !o.stats.alive) continue;
    const od = Math.hypot(o.root.position.x - p.x, o.root.position.z - p.z);
    if (od < 5) { o.stats.hp -= 80; o.flinch('body', 1); if (o.stats.hp <= 0) { o.stats.alive = false; o.die(Math.atan2(o.root.position.x - p.x, o.root.position.z - p.z)); } }
  }
  z.stats.alive = false;
  z.die(Math.random() * Math.PI * 2);
  z.root.visible = false;
}
const shockwaves = [];

function damagePlayer(dmg, fromPos) {
  if (gameState !== 'playing') return;
  player.health = Math.max(0, player.health - dmg);
  audio.hurt();
  const v = document.getElementById('vignette');
  v.style.opacity = Math.min(0.9, dmg / 25);
  dmgVig = 0.6;
  if (fromPos) {
    const ang = Math.atan2(fromPos.x - player.pos.x, fromPos.z - player.pos.z) - player.yaw;
    const arr = document.getElementById('dmgArrow');
    arr.style.opacity = 1;
    arr.querySelector('.arr').style.transform = `rotate(${-ang}rad)`;
    dmgArrowT = 0.8;
  }
  if (player.health <= 0) gameOver();
}
let dmgVig = 0, dmgArrowT = 0;
function gameOver() {
  gameState = 'over';
  if (score > highScore) { highScore = score; localStorage.setItem('ds-highscore', highScore); }
  $('goStats').innerHTML = `Score: <b>${score}</b><br>Wave: <b>${wave}</b> &nbsp; Kills: <b>${kills}</b><br>High score: <b>${highScore}</b>`;
  document.getElementById('gameover').classList.add('on');
  document.exitPointerLock?.();
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
  if (code === 'KeyG' && gameState === 'playing') armGrenade();
  if (code === 'KeyV' && gameState === 'playing') melee();
  if (code === 'KeyF') { flashlightOn = !flashlightOn; if (flashSpot) flashSpot.visible = flashlightOn; }
  if (code === 'KeyM') { audio.muted = !audio.muted; $('muteTag').style.display = audio.muted ? 'block' : 'none'; }
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
let flashlightOn = false, wave = 1;
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
  noiseHeard(w.noise * (silencer ? 0.4 : 1));
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
        if (h.object.userData.crate) {
          const cr = h.object.userData.crate;
          worldRayGroup.remove(h.object);
          worldRayboxes.splice(worldRayboxes.indexOf(h.object), 1);
          scene.remove(cr.mesh);
          crates.splice(crates.indexOf(h.object), 1);
          grenadeExplode(new THREE.Vector3(cr.x, 0.6, cr.z));
          break;
        }
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
  aiOnDead(zom.ai);
  releaseSlot(aiSlots, zom.id);
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
  if (zone === 'head') audio.headshot();
  directorNoteKill(director, clock.elapsedTime);
  if (Math.random() < 0.12) spawnPickup(zom.root.position.x, zom.root.position.z, ['ammo', 'health', 'grenade'][Math.floor(Math.random() * 3)]);
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

// ---------- audio ----------
import { initAudio, sfx, setVolume, setMuted, updateListener, setDroneIntensity } from './audio.js';
const audio = {
  ensure() { initAudio(); },
  shot(id) { sfx.shot(id); },
  dry() { sfx.dry(); },
  emptyClick(p) { sfx.emptyClick(p); },
  hit() { sfx.hit(); },
  kill() { sfx.kill(); },
  reload() { sfx.reloadIn(); },
  scream() { sfx.scream(); },
  spit() { sfx.spit(); },
  explosion() { sfx.explosion(); },
  hurt() { sfx.hurt(); },
  woodBreak() { sfx.woodBreak(); },
  groan(x, y, z) { sfx.groan(x, y, z); },
  melee() { sfx.melee(); },
  pickup() { sfx.pickup(); },
  clink() { sfx.clink(); },
  footstep(s) { sfx.footstep(s); },
  heartbeat() { sfx.heartbeat(); },
  headshot() { sfx.headshot(); },
  roar() { sfx.roar(); },
  bloaterPop() { sfx.bloaterPop(); },
  set vol(v) { setVolume(v); },
  set muted(m) { setMuted(m); },
  get muted() { return false; },
};
let footT = 0, clinkT = 0, heartT = 0;

// ---------- input / player ----------
let playerMoving = false;
function collidersNow() { return mapWorld ? [...mapWorld.colliders, ...mapWorld.fenceColliders] : []; }
function updatePlayer(dt) {
  const sens = 0.0022 * sensMul;
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

// ---------- debug AI overlay ----------
const dbgLabels = [];
let flowArrows = null;
function updateDebugAI() {
  let i = 0;
  for (const z of zombies) {
    if (!z.stats.alive) continue;
    let d = dbgLabels[i];
    if (!d) { d = document.createElement('div'); d.style.cssText = 'position:absolute;color:#0f0;font:11px monospace;text-shadow:0 0 3px #000;pointer-events:none;'; document.body.appendChild(d); dbgLabels[i] = d; }
    d.style.display = 'block';
    d.textContent = z.ai.state + (z.ai.alerted ? '!' : '');
    const v = z.root.position.clone().setY(2.1).project(camera);
    d.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
    d.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    i++;
  }
  for (; i < dbgLabels.length; i++) dbgLabels[i].style.display = 'none';
  if (VIEW === 'map' && flowDist && !flowArrows) {
    const pts = [];
    for (let gz = 0; gz < navGrid.h; gz += 5) for (let gx = 0; gx < navGrid.w; gx += 5) {
      const x = navGrid.ox + (gx + 0.5) * navGrid.cell, z = navGrid.oz + (gz + 0.5) * navGrid.cell;
      const fd = flowDir(navGrid, flowDist, x, z);
      if (fd) { pts.push(x, 0.5, z, x + fd.x * 1.6, 0.5, z + fd.z * 1.6); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    flowArrows = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00ff88 }));
    scene.add(flowArrows);
  }
}

// ---------- game flow ----------
import { createDirector, directorUpdate, directorNoteKill, waveComposition, shouldDropSupply, breakDuration, directorWantsHorde } from './logic/director.js';
import { SHOP, canBuy, applyPurchase } from './logic/economy.js';

let gameState = 'menu'; // menu, playing, paused, buy, over
const director = createDirector();
let waveActive = false, breakT = 0, aliveInWave = 0, lastSlowmoWave = -1;
let grenades = 2, silencer = false;
const pickups = [];
const crates = [];
let grenadeArmed = false, grenadePreview = null, armedT = 0;
let flashlightOn2 = false;
let highScore = +(localStorage.getItem('ds-highscore') || 0);

function startGame() {
  initAudio();
  $('startScreen').classList.remove('on');
  $('hud').classList.add('on');
  gameState = 'playing';
  canvas.requestPointerLock?.();
  startWave(1);
}
function startWave(n) {
  wave = n;
  $('waveVal').textContent = n;
  const comp = waveComposition(n);
  let toSpawn = [];
  for (const [t, c] of Object.entries(comp)) { if (t !== 'horde') for (let i = 0; i < c; i++) toSpawn.push(t); }
  if (directorWantsHorde(n)) showBanner('THE HORDE COMES');
  else showBanner('WAVE ' + n);
  for (const t of toSpawn) {
    const sp = pickSpawn();
    const z = spawnZombie(sp.x, sp.z, Math.random() < 0.5 ? skinA : skinC, { type: t });
    z.ai.alerted = true; z.ai.state = S.CHASE;
  }
  waveActive = true;
}
function pickSpawn() {
  let best = null, bestD = -1;
  for (let i = 0; i < 6; i++) {
    const s = map.spawns[Math.floor(Math.random() * map.spawns.length)];
    const d = Math.hypot(s.x - player.pos.x, s.z - player.pos.z);
    if (d > bestD) { bestD = d; best = s; }
  }
  const [fx2, fz2] = nearestFree(navGrid, best.x, best.z);
  return { x: fx2, z: fz2 };
}
function showBanner(txt) {
  const b = $('waveBanner');
  b.textContent = txt; b.style.opacity = 1;
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.style.opacity = 0; }, 2500);
}
let bannerT = 0;

function checkWaveEnd(dt) {
  if (!waveActive || gameState !== 'playing') return;
  const alive = zombies.filter(z => z.stats.alive).length;
  if (alive === 0) {
    waveActive = false;
    if (wave !== lastSlowmoWave) { lastSlowmoWave = wave; slowmo = 0.35; setTimeout(() => slowmo = 1, 900); }
    breakT = breakDuration(wave);
    openBuy();
  }
  // slow-mo when last zombie of wave
}

function openBuy() {
  gameState = 'buy';
  document.exitPointerLock?.();
  breakT = breakDuration(wave);
  $('buyMenu').classList.add('on');
  buildBuyGrid();
}
function buildBuyGrid() {
  $('buyCash').textContent = score;
  const g = $('buyGrid'); g.innerHTML = '';
  const state = { owned: { smg: ammoStates.smg.owned, shotgun: ammoStates.shotgun.owned, rifle: ammoStates.rifle.owned }, silencer, health: player.health, grenades };
  for (const item of SHOP) {
    const d = document.createElement('div');
    d.className = 'buyItem';
    d.innerHTML = `<div class="bi-name">${item.name}</div><div style="font-size:11px;color:#8aa">${item.desc}</div><div class="bi-cost">${item.cost} pts</div>`;
    d.onclick = () => {
      if (!canBuy(item, score, state)) return;
      score -= item.cost;
      applyPurchase(item, state);
      if (item.id === 'ammo') { const a = ammoStates[curWeapon]; a.reserve = WEAPONS[curWeapon].reserveMax; updateHudAmmo(); }
      if (item.id === 'smg') ammoStates.smg.owned = true;
      if (item.id === 'shotgun') ammoStates.shotgun.owned = true;
      if (item.id === 'rifle') ammoStates.rifle.owned = true;
      if (item.id === 'silencer') silencer = true;
      if (item.id === 'grenade') grenades = state.grenades;
      player.health = state.health;
      updateHudTop(); buildBuyGrid();
    };
    g.appendChild(d);
  }
}
$('btnBuyClose').onclick = () => {
  $('buyMenu').classList.remove('on');
  gameState = 'playing';
  canvas.requestPointerLock?.();
};
$('btnStart').onclick = startGame;
$('btnResume').onclick = () => { $('pauseScreen').classList.remove('on'); gameState = 'playing'; canvas.requestPointerLock?.(); };
$('btnQuit').onclick = () => location.reload();
$('btnRetry').onclick = () => location.reload();
$('btnPauseShow').onclick = () => $('pauseScreen').classList.add('on');
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && gameState === 'playing') {
    gameState = 'paused';
    $('pauseScreen').classList.add('on');
  }
});
$('sensSlider').oninput = e => { sensMul = e.target.value / 100; };
$('volSlider').oninput = e => { audio.vol = e.target.value / 100; };
let sensMul = 1;

// ---------- grenades / melee / flashlight ----------
function throwGrenade() {
  if (grenades <= 0) return;
  grenades--;
  const g = grenadeMeshProto.clone();
  g.position.copy(camera.position).add(new THREE.Vector3(0.2, -0.15, -0.4).applyEuler(camera.rotation));
  const v = new THREE.Vector3(0, 0, 1).applyEuler(camera.rotation).multiplyScalar(11);
  v.y += 2.5;
  scene.add(g);
  grenadesFly.push({ m: g, vel: v, fuse: 2 });
  grenadeArmed = false;
  if (grenadePreview) { scene.remove(grenadePreview); grenadePreview = null; }
}
const grenadesFly = [];
let grenadeMeshProto = null, flashSpot = null;
function armGrenade() {
  if (grenades <= 0 || grenadeArmed) return;
  grenadeArmed = true; armedT = 0;
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push(new THREE.Vector3());
  grenadePreview = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.8 }));
  scene.add(grenadePreview);
}
function updateGrenadePreview(dt) {
  if (!grenadeArmed) return;
  armedT += dt;
  const v = new THREE.Vector3(0, 0, 1).applyEuler(camera.rotation).multiplyScalar(11); v.y += 2.5;
  const p = camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.4).applyEuler(camera.rotation));
  const pos = grenadePreview.geometry.attributes.position;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20 * 1.2;
    pos.setXYZ(i, p.x + v.x * t, Math.max(0.05, p.y + v.y * t - 4.9 * t * t), p.z + v.z * t);
  }
  pos.needsUpdate = true;
  if (armedT > 2.2) throwGrenade();
}
function grenadeExplode(pos) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 1.2, 28),
    new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 1, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  ring.rotation.x = -Math.PI / 2; ring.position.copy(pos).setY(0.1);
  scene.add(ring); shockwaves.push({ m: ring, life: 0.6 });
  const fl = new THREE.PointLight(0xffeecc, 300, 30); fl.position.copy(pos).setY(1.5); scene.add(fl);
  setTimeout(() => scene.remove(fl), 90);
  audio.explosion();
  player.shake = 2;
  for (let i = 0; i < 20; i++) fx.burst(pos, 'spark', new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5));
  for (const z of zombies) {
    if (!z.stats.alive) continue;
    const d = z.root.position.distanceTo(pos);
    if (d < 6) {
      z.stats.hp -= 160 * (1 - d / 6);
      if (z.stats.hp <= 0) { z.stats.alive = false; onZombieDeath(z, 'body', new THREE.Vector3(z.root.position.x - pos.x, 0, z.root.position.z - pos.z)); }
      else { z.knockdown(); }
    }
  }
  const pd = Math.hypot(player.pos.x - pos.x, player.pos.z - pos.z);
  if (pd < 4) damagePlayer(20 * (1 - pd / 4), pos);
}
function melee() {
  audio.melee();
  const f = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
  for (const z of zombies) {
    if (!z.stats.alive) continue;
    const dx = z.root.position.x - player.pos.x, dz = z.root.position.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.6 && (dx * -f.x + dz * -f.z) / (d || 1) > 0.4) {
      z.kb = 8; z.kbDir = Math.atan2(dx, dz);
      z.stagger(); z.interruptAttack();
      z.stats.hp -= 20;
      if (z.stats.hp <= 0) { z.stats.alive = false; onZombieDeath(z, 'body', new THREE.Vector3(dx, 0, dz)); }
    }
  }
  vm.kick = 1.2; vm.kickRot = 0.8;
}

// ---------- pickups ----------
function spawnPickup(x, z, kind) {
  const colors = { ammo: 0xffd24a, health: 0x44ff66, grenade: 0xff8844 };
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.22),
    new THREE.MeshStandardMaterial({ color: colors[kind], emissive: colors[kind], emissiveIntensity: 0.7 }));
  m.position.set(x, 0.6, z);
  scene.add(m);
  pickups.push({ m, kind, life: 30 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.life -= dt;
    p.m.rotation.y += dt * 2.5;
    p.m.position.y = 0.6 + Math.sin(clock.elapsedTime * 3 + i) * 0.08;
    if (Math.hypot(p.m.position.x - player.pos.x, p.m.position.z - player.pos.z) < 1.2) {
      if (p.kind === 'ammo') { const a = ammoStates[curWeapon]; a.reserve = Math.min(WEAPONS[curWeapon].reserveMax, a.reserve + WEAPONS[curWeapon].clip * 2); updateHudAmmo(); }
      if (p.kind === 'health') player.health = Math.min(100, player.health + 30);
      if (p.kind === 'grenade') grenades++;
      audio.pickup();
      scene.remove(p.m); pickups.splice(i, 1); continue;
    }
    if (p.life <= 0) { scene.remove(p.m); pickups.splice(i, 1); }
  }
}

// ---------- minimap ----------
const mmCtx = $('minimap').getContext('2d');
let mmT = 0;
function drawMinimap() {
  const c = mmCtx, S2 = 170 / 120;
  c.clearRect(0, 0, 170, 170);
  c.fillStyle = 'rgba(0,0,10,0.4)'; c.fillRect(0, 0, 170, 170);
  c.fillStyle = 'rgba(120,130,160,0.5)';
  for (const b of map.boxes) {
    if (b.kind !== 'house') continue;
    c.fillRect((b.x + 60 - b.hw) * S2, (b.z + 60 - b.hd) * S2, b.hw * 2 * S2, b.hd * 2 * S2);
  }
  for (const z of zombies) {
    if (!z.stats.alive) continue;
    const t = z.type || 'walker';
    c.fillStyle = '#' + new THREE.Color(TYPES[t].tint).getHexString();
    c.beginPath();
    c.arc((z.root.position.x + 60) * S2, (z.root.position.z + 60) * S2, 2.5, 0, 7);
    c.fill();
  }
  c.save();
  c.translate((player.pos.x + 60) * S2, (player.pos.z + 60) * S2);
  c.rotate(-player.yaw);
  c.fillStyle = '#fff';
  c.beginPath(); c.moveTo(0, -5); c.lineTo(3.5, 4); c.lineTo(-3.5, 4); c.fill();
  c.restore();
}

// ---------- demo ----------
let demoMode = DEMO;
if (DEMO) { document.getElementById('startScreen').classList.remove('on'); gameState = 'demo'; }

async function init() {
  const { guns, clip, foam, crate } = await loadAssets();
  grenadeMeshProto = foam;
  flashSpot = new THREE.SpotLight(0xfff2cc, 120, 34, 0.42, 0.35, 1.6);
  flashSpot.visible = false;
  flashSpot.castShadow = false;
  camera.add(flashSpot);
  const tget = new THREE.Object3D(); tget.position.set(0, 0, -1); camera.add(tget);
  flashSpot.target = tget;
  crateProto = crate;
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
    if (VIEW === 'ads') { aiming = true; vm.adsAmt = 1; }
    if (VIEW === 'weapon') { player.pitch = -0.25; }
    if (DEMO) $('hud').classList.add('on');
    updateHudWeapon(); updateHudTop();
  }

  const zbase = VIEW === 'zombies' ? -2.6 : -4;
  if (params.get('types') === '1') {
    const list = ['walker', 'runner', 'crawler', 'brute', 'screamer', 'spitter', 'bloater'];
    list.forEach((t, i) => {
      const z = spawnZombie((i - 3) * 1.7, -4.5, i % 2 ? skinA : skinC, { type: t });
      z.root.rotation.y = Math.PI; z.setMove(0.6);
    });
  } else if (ANIM) {
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
  placeCrates();
  if (params.has('wave')) setTimeout(() => { gameState = 'playing'; startWave(1); }, 300);
  if (params.has('buy')) setTimeout(() => { score = 1200; gameState = 'buy'; openBuy(); }, 300);
  if (params.has('z50')) {
    gameState = 'playing';
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 14;
      const z = spawnZombie(player.pos.x + Math.sin(a) * r, player.pos.z + Math.cos(a) * r, i % 2 ? skinA : skinC, { type: 'walker' });
      z.ai.alerted = true; z.ai.state = S.CHASE;
    }
    let frames = 0, t0 = performance.now();
    const iv = setInterval(() => {
      frames++;
      if (performance.now() - t0 > 2000) { console.log('[perf] fps~', Math.round(frames / 2)); clearInterval(iv); }
    }, 0);
    requestAnimationFrame(function cnt() { frames++; requestAnimationFrame(cnt); });
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
  if (VIEW === 'ads') { aiming = true; vm.adsAmt = 1; }
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
  attackers = 0;
  flowTimer -= dt;
  if (flowTimer <= 0) { rebuildFlow(); flowTimer = 0.5; }
  let frame = (frameNo = (frameNo + 1) % 2);
  for (const z of zombies) {
    if (z.stats.alive && VIEW !== 'map' && !ANIM && (z.root.position.distanceTo(camera.position) < 45 || frame === z.id % 2)) {
      updateZombieAI(z, dt, frame);
    }
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
  // projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.life -= dt; pr.vel.y -= 9.8 * dt;
    pr.m.position.addScaledVector(pr.vel, dt);
    if (pr.m.position.y < 0.1 || pr.life <= 0) {
      scene.remove(pr.m); projectiles.splice(i, 1);
      const pp = pr.m.position.clone(); pp.y = 0.03;
      const puddle = new THREE.Mesh(new THREE.CircleGeometry(1.4, 16),
        new THREE.MeshBasicMaterial({ color: 0x3fae2a, transparent: true, opacity: 0.75 }));
      puddle.rotation.x = -Math.PI / 2; puddle.position.copy(pp);
      scene.add(puddle); puddles.push({ m: puddle, life: 6 });
      fx.burst(pp, 'goo', new THREE.Vector3(0, 1, 0));
    }
  }
  for (let i = puddles.length - 1; i >= 0; i--) {
    const pd = puddles[i]; pd.life -= dt;
    pd.m.material.opacity = Math.min(0.75, pd.life / 6);
    if (Math.hypot(player.pos.x - pd.m.position.x, player.pos.z - pd.m.position.z) < 1.3) damagePlayer(8 * dt, pd.m.position);
    if (pd.life <= 0) { scene.remove(pd.m); puddles.splice(i, 1); }
  }
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i]; sw.life -= dt;
    sw.m.scale.setScalar(1 + (0.5 - sw.life) * 14);
    sw.m.material.opacity = Math.max(0, sw.life * 1.8);
    if (sw.life <= 0) { scene.remove(sw.m); shockwaves.splice(i, 1); }
  }
  if (dmgVig > 0) { dmgVig -= dt; $('vignette').style.opacity = Math.max(0, dmgVig); }
  if (dmgArrowT > 0) { dmgArrowT -= dt; if (dmgArrowT <= 0) $('dmgArrow').style.opacity = 0; }
  if (DEBUG_AI) updateDebugAI();
  updateGrenadePreview(dt);
  for (let i = grenadesFly.length - 1; i >= 0; i--) {
    const gr = grenadesFly[i];
    gr.fuse -= dt; gr.vel.y -= 14 * dt;
    gr.m.position.addScaledVector(gr.vel, dt);
    if (gr.m.position.y < 0.12) { gr.m.position.y = 0.12; gr.vel.y *= -0.4; gr.vel.x *= 0.7; gr.vel.z *= 0.7; }
    if (gr.fuse <= 0) { grenadeExplode(gr.m.position.clone()); scene.remove(gr.m); grenadesFly.splice(i, 1); }
  }
  updatePickups(dt);
  if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) $('waveBanner').style.opacity = 0; }
  if (gameState === 'playing') {
    directorUpdate(director, dt, { health: player.health, ammoFrac: ammoStates[curWeapon].reserve / WEAPONS[curWeapon].reserveMax, px: player.pos.x, pz: player.pos.z, time: t });
    checkWaveEnd(dt);
    if (shouldDropSupply(director) && Math.random() < dt * 0.05) {
      const sp = pickSpawn();
      spawnPickup(sp.x, sp.z, player.health < 40 ? 'health' : 'ammo');
    }
    if (director.pendingSpecials > 0 && Math.random() < dt * 0.3) {
      director.pendingSpecials--;
      const sp = pickSpawn();
      const z = spawnZombie(sp.x, sp.z, skinC, { type: ['screamer', 'brute', 'spitter'][Math.floor(Math.random() * 3)] });
      z.ai.alerted = true; z.ai.state = S.CHASE;
    }
    // slow-mo when exactly one zombie left in wave
    const aliveN = zombies.reduce((a, z) => a + (z.stats.alive ? 1 : 0), 0);
    if (waveActive && aliveN === 1 && slowmo === 1) slowmo = 0.4;
    else if (aliveN !== 1 && slowmo === 0.4) slowmo = 1;
  }
  if (gameState === 'buy') {
    breakT -= dt;
    $('buyTimer').textContent = Math.ceil(breakT);
    if (breakT <= 0) { $('buyMenu').classList.remove('on'); gameState = 'playing'; canvas.requestPointerLock?.(); startWave(wave + 1); }
  }
  mmT -= dt; if (mmT <= 0 && gameState !== 'menu') { drawMinimap(); mmT = 0.15; }
  // 3D groans + drone intensity + footsteps + heartbeat
  {
    let near = null, nd = 1e9, aliveN = 0;
    for (const z of zombies) { if (!z.stats.alive) continue; aliveN++; const d = z.root.position.distanceTo(camera.position); if (d < nd) { nd = d; near = z; } }
    setDroneIntensity(aliveN / 30 + hordeAlert);
    hordeAlert = Math.max(0, hordeAlert - dt);
    if (near && nd < 22 && Math.random() < dt * 0.5) {
      const gp = near.root.position;
      audio.groan(gp.x, 1.2, gp.z);
    }
  }
  if (moving && player.onGround) { footT -= dt; if (footT <= 0) { audio.footstep(player.sprinting); footT = player.sprinting ? 0.28 : 0.42; } }
  clinkT -= dt;
  if (clinkT <= 0 && fx.shells.some(sh => sh.m.visible && sh.settled && !sh.clinked)) {
    for (const sh of fx.shells) if (sh.m.visible && sh.settled && !sh.clinked) { sh.clinked = true; audio.clink(); break; }
    clinkT = 0.05;
  }
  if (player.health < 30 && gameState === 'playing') { heartT -= dt; if (heartT <= 0) { audio.heartbeat(); heartT = 1.1; } }
  updateListener(camera.position, new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation));

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
let firedOnce = false, lastFireHeld = false, lastDemoShot = 0, frameNo = 0;
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
