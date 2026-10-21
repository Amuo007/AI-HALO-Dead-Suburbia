import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const BONE_NAMES = ['Hips','Spine','Neck','Head','LeftShoulder','RightShoulder',
  'LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand',
  'LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];

let boneNamesPrinted = false;

export class ZombieTemplate {
  constructor(model, scale, clips) {
    this.model = model;
    this.scale = scale;
    this.clips = clips; // {idle, run, jump}
  }
}

export async function loadZombieTemplate(FBXLoader, base) {
  const loader = new FBXLoader();
  const model = await loader.loadAsync(base + 'Model/characterMedium.fbx');
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = 1.8 / size.y;
  model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; } });
  const [idle, run, jump] = await Promise.all(['idle','run','jump'].map(n => loader.loadAsync(base + 'Animations/' + n + '.fbx')));
  const clips = { idle: idle.animations[0], run: run.animations[0], jump: jump.animations[0] };
  if (!boneNamesPrinted) {
    boneNamesPrinted = true;
    const names = [];
    model.traverse(o => { if (o.isBone) names.push(o.name); });
    console.log('[DeadSuburbia] skeleton bone names:', JSON.stringify(names));
  }
  return new ZombieTemplate(model, scale, clips);
}

export function makeZombieSkin(texLoader, url) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const HIT_DEFS = [
  { zone: 'head', bone: 'Head', r: 0.17, off: [0, 0.12, 0] },
  { zone: 'chest', bone: 'Spine', r: 0.30, off: [0, 0.16, 0] },
  { zone: 'hips', bone: 'Hips', r: 0.26, off: [0, 0.02, 0] },
  { zone: 'legs', bone: 'LeftUpLeg', r: 0.20, off: [0, -0.2, 0] },
  { zone: 'legs', bone: 'RightUpLeg', r: 0.20, off: [0, -0.2, 0] },
];

const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const hitGeo = new THREE.SphereGeometry(1, 8, 6);

let nextId = 1;

export class Zombie {
  constructor(template, skin, opts = {}) {
    this.id = nextId++;
    this.root = new THREE.Group();
    this.body = new THREE.Object3D();
    this.root.add(this.body);
    this.mesh = SkeletonUtils.clone(template.model);
    this.body.add(this.mesh);
    this.mesh.scale.setScalar(template.scale * (opts.sizeMul || 1));
    this.mesh.traverse(o => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.material = o.material.clone();
        o.material.map = skin;
        o.material.transparent = false;
        o.material.opacity = 1;
        o.material.vertexColors = false;
        if (opts.tint) { o.material.color = new THREE.Color(opts.tint); }
      }
    });
    this.bones = {};
    this.mats = [];
    this.mesh.traverse(o => { if (o.isMesh) { this.mats.push(o.material); o.material.emissive = new THREE.Color(0, 0, 0); } });
    this.flashT = 0;
    this.mesh.traverse(o => { if (o.isBone && BONE_NAMES.includes(o.name)) this.bones[o.name] = o; });

    this.mixer = new THREE.AnimationMixer(this.mesh);
    const A = {};
    for (const [k, clip] of Object.entries(template.clips)) {
      A[k] = this.mixer.clipAction(clip, this.mesh);
      A[k].play();
    }
    A.idle.weight = 0; A.run.weight = 1; A.jump.weight = 0;
    this.actions = A;
    A.run.timeScale = 0.5;

    // hit spheres parented to bones so they follow the animation
    this.hitSpheres = [];
    for (const h of HIT_DEFS) {
      const bone = this.bones[h.bone];
      if (!bone) continue;
      const m = new THREE.Mesh(hitGeo, hitMat);
      m.scale.setScalar(h.r * (opts.sizeMul || 1));
      m.position.set(...h.off);
      m.userData.zone = h.zone;
      m.userData.zombie = this;
      bone.add(m);
      this.hitSpheres.push(m);
    }

    // per-zombie personality so no two move the same
    const r = opts.rand || Math.random;
    this.p = {
      speedMul: 0.8 + r() * 0.5,
      swayPhase: r() * Math.PI * 2,
      swayFreq: 1.6 + r() * 0.9,
      limpSide: r() < 0.5 ? 'L' : 'R',
      armHeight: 0.75 + r() * 0.5,
      hunch: 0.28 + r() * 0.2,
      headTilt: (r() - 0.5) * 0.5,
      lean: (r() - 0.5) * 0.12,
    };
    // animation layer state
    this.a = {
      move: 0,            // 0..1 blend idle->run
      attackT: -1, attackDur: 0.7,
      flinchT: -1, flinchDur: 0.4, flinchKind: 'body', flinchDir: 0,
      staggerT: -1, staggerDur: 1.2,
      knock: 0, knockTarget: 0,   // 0 upright 1 down
      crawl: false, crawlPhase: 0,
      death: null,        // {t, x, v, fallYaw}
      freeze: false,
      time: r() * 10,
    };
  }

  startAttack() { if (this.a.attackT < 0 && !this.a.death) this.a.attackT = 0; }
  interruptAttack() { this.a.attackT = -1; }
  flinch(kind, dirAngle) {
    if (this.a.death || this.a.knockTarget > 0.5) return;
    this.a.flinchT = 0; this.a.flinchKind = kind; this.a.flinchDir = dirAngle || 0;
  }
  stagger() { this.a.staggerT = 0; }
  knockdown() { this.a.knockTarget = 1; this.a.attackT = -1; }
  getUp() { this.a.knockTarget = 0; }
  setCrawl(on) { this.a.crawl = on; if (on) this.a.knockTarget = 0; }
  die(fallYaw) {
    this.a.death = { t: 0, x: 0, v: 0, fallYaw };
    this.a.attackT = -1; this.a.knockTarget = 0; this.a.crawl = false;
  }

  setMove(m) { this.a.move = m; }

  update(dt) {
    const a = this.a, p = this.p;
    if (this.flashT > 0) {
      this.flashT -= dt;
      const f = Math.max(0, this.flashT / 0.08);
      for (const m of this.mats) m.emissive.setRGB(f, f, f);
    }
    if (!a.freeze) a.time += dt;
    const t = a.time;
    const dead = !!a.death;

    // ---- mixer ----
    const runSpeed = (0.4 + 0.2 * p.swayFreq % 0.2) + 0.15; // shamble 0.4-0.6x
    this.actions.run.timeScale = dead ? 0.05 : (a.crawl ? 0.35 : (0.4 + (p.swayFreq - 1.6) * 0.5) * (this.timeScaleMul || 1));
    this.actions.idle.enabled = true;
    const m = dead ? 0 : (a.crawl ? 0.25 : a.move);
    this.actions.run.weight = m;
    this.actions.idle.weight = 1 - m;
    if (!a.freeze) this.mixer.update(dt);

    const B = this.bones;
    const up = dead ? Math.max(0, 1 - a.death.t * 3) : (1 - a.knock);
    const damp = (cur, target, rate) => cur + (target - cur) * Math.min(1, rate * dt);

    // reset helper: bones already hold animated values; we add offsets each frame after mixer.
    // ---- base zombie pose (hunch, arms up, head tilt) ----
    const pose = up * (a.crawl ? 0.4 : 1);
    if (B.Spine) {
      B.Spine.rotation.x += 0.12 * pose * (p.hunch / 0.3);
      B.Spine.rotation.z += p.lean * pose;
    }
    if (B.Neck) B.Neck.rotation.x -= 0.25 * pose;
    if (B.Head) {
      B.Head.rotation.z += p.headTilt * pose;
      B.Head.rotation.x -= 0.15 * pose;
    }
    const armUp = pose * p.armHeight;
    const breathe = Math.sin(t * 1.7) * 0.05;
    for (const side of ['Left', 'Right']) {
      const arm = B[side + 'Arm'], fore = B[side + 'ForeArm'], sh = B[side + 'Shoulder'];
      if (!arm) continue;
      const s = side === 'Left' ? 1 : -1;
      arm.rotation.x += (-1.15 * armUp) + breathe * s;
      arm.rotation.z += s * (0.25 + 0.1 * armUp);
      arm.rotation.y += s * 0.15 * armUp;
      if (fore) fore.rotation.x += -0.55 * armUp;
      if (sh) sh.rotation.z += s * 0.1 * armUp;
    }

    // ---- shamble: sway + limp ----
    if (B.Hips && !dead) {
      const sway = Math.sin(t * p.swayFreq) * 0.07 * (0.4 + a.move);
      B.Hips.rotation.z += sway * up;
      B.Hips.rotation.y += Math.sin(t * p.swayFreq * 0.5) * 0.06 * up;
      B.Hips.position.y += Math.abs(Math.sin(t * p.swayFreq)) * 0.012 * a.move;
    }
    const limp = (side) => side === p.limpSide ? 1 : 0.15;
    if (B.LeftLeg) B.LeftLeg.rotation.x += 0.45 * limp('L') * (0.3 + a.move) * up * Math.max(0, Math.sin(t * p.swayFreq * 2));
    if (B.RightLeg) B.RightLeg.rotation.x += 0.45 * limp('R') * (0.3 + a.move) * up * Math.max(0, Math.sin(t * p.swayFreq * 2 + Math.PI));
    if (B.LeftUpLeg) B.LeftUpLeg.rotation.x += 0.15 * limp('L') * a.move * up;
    if (B.RightUpLeg) B.RightUpLeg.rotation.x += 0.15 * limp('R') * a.move * up;

    // ---- attack: lunge + arm swipe ----
    if (a.attackT >= 0) {
      if (!a.freeze) a.attackT += dt;
      const u = Math.min(1, a.attackT / a.attackDur);
      let lunge = 0, swipe = 0;
      if (u < 0.35) { lunge = -0.15 * (u / 0.35); swipe = -0.6 * (u / 0.35); }        // wind up
      else if (u < 0.55) { const w = (u - 0.35) / 0.2; lunge = -0.15 + 0.5 * w; swipe = -0.6 + 2.4 * w; } // swipe
      else { const w = (u - 0.55) / 0.45; lunge = 0.35 * (1 - w); swipe = 1.8 * (1 - w); }
      if (u >= 1) a.attackT = -1;
      if (B.Spine) B.Spine.rotation.x += lunge;
      for (const side of ['Left', 'Right']) {
        const arm = B[side + 'Arm'], fore = B[side + 'ForeArm'];
        if (arm) arm.rotation.x += swipe * 0.5;
        if (fore) fore.rotation.x += swipe * 0.45;
      }
      this.attackHitPending = (u >= 0.45 && u < 0.6);
    } else this.attackHitPending = false;

    // ---- flinch (direction aware) ----
    if (a.flinchT >= 0) {
      if (!a.freeze) a.flinchT += dt;
      const u = a.flinchT / a.flinchDur;
      const curve = u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75;
      if (u >= 1) a.flinchT = -1;
      if (a.flinchKind === 'head' && B.Head) { B.Head.rotation.x -= 0.7 * curve; B.Neck && (B.Neck.rotation.x -= 0.3 * curve); }
      if (a.flinchKind === 'body' && B.Spine) {
        B.Spine.rotation.y += Math.sin(a.flinchDir) * 0.45 * curve;
        B.Spine.rotation.x += 0.25 * curve;
      }
      if (a.flinchKind === 'leg') {
        const leg = B[a.flinchDir > 0 ? 'RightLeg' : 'LeftLeg'] || B.LeftLeg;
        if (leg) leg.rotation.x += 0.9 * curve;
        if (B.Hips) B.Hips.position.y -= 0.06 * curve;
        if (B.Spine) B.Spine.rotation.x += 0.2 * curve;
      }
    }

    // ---- stagger ----
    if (a.staggerT >= 0) {
      if (!a.freeze) a.staggerT += dt;
      const u = a.staggerT / a.staggerDur;
      if (u >= 1) a.staggerT = -1;
      const w = (1 - u) * Math.sin(t * 14);
      if (B.Spine) { B.Spine.rotation.z += w * 0.25; B.Spine.rotation.x -= 0.15 * (1 - u); }
      if (B.Hips) B.Hips.position.x += w * 0.03;
    }

    // ---- knockdown / get up (smooth) ----
    a.knock = damp(a.knock, a.knockTarget, 6);
    if (a.knock > 0.001 && !dead) {
      this.body.rotation.x = -1.35 * a.knock;
      this.body.position.y = -0.1 * a.knock;
    } else if (!dead && !a.crawl) {
      this.body.rotation.x = damp(this.body.rotation.x, 0, 8);
      this.body.position.y = damp(this.body.position.y, 0, 8);
    }

    // ---- crawl: body flat, arms pulling ----
    if (a.crawl && !dead) {
      this.body.rotation.x = damp(this.body.rotation.x, 1.45, 6);
      this.body.position.y = damp(this.body.position.y, -0.15, 6);
      a.crawlPhase += dt * 4 * (0.5 + a.move);
      const pull = Math.sin(a.crawlPhase);
      for (const side of ['Left', 'Right']) {
        const arm = B[side + 'Arm'], fore = B[side + 'ForeArm'];
        const s = Math.sin(a.crawlPhase + (side === 'Left' ? 0 : Math.PI));
        if (arm) { arm.rotation.x += -0.4 + s * 0.5; arm.rotation.z += (side === 'Left' ? 1 : -1) * 0.5; }
        if (fore) fore.rotation.x += -0.5 - s * 0.4;
        const up2 = B[side + 'UpLeg'], lo = B[side + 'Leg'];
        if (up2) up2.rotation.x -= 0.6;
        if (lo) lo.rotation.x += 0.7;
      }
      if (B.Neck) B.Neck.rotation.x -= 0.9;
      if (B.Head) B.Head.rotation.x -= 0.5;
    }

    // ---- death: tip over in shot direction with spring bounce ----
    if (a.death) {
      const d = a.death;
      if (!a.freeze) d.t += dt;
      // spring: x -> 1 (fully tipped)
      const k = 26, c = 4.2;
      const acc = k * (1 - d.x) - c * d.v;
      d.v += acc * dt; d.x += d.v * dt;
      const tip = Math.max(0, Math.min(1.12, d.x));
      // orient fall direction smoothly
      const curYaw = this.root.rotation.y;
      let dy = d.fallYaw - curYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.root.rotation.y += dy * Math.min(1, dt * 6);
      this.body.rotation.x = 1.5 * tip;
      this.body.position.y = -0.08 * Math.min(1, tip);
      this.body.rotation.z = Math.sin(d.t * 9) * 0.08 * Math.max(0, 1 - d.t * 0.8);
      // arms go limp
      for (const side of ['Left', 'Right']) {
        const arm = B[side + 'Arm'];
        if (arm) arm.rotation.x += (1 - tip) * -0.4;
      }
    }
  }
}
