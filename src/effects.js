import * as THREE from 'three';

function softTex(color) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
function holeTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(10,10,10,0.95)';
  g.beginPath(); g.arc(32, 32, 9 + Math.random() * 4, 0, 7); g.fill();
  g.fillStyle = 'rgba(60,55,50,0.5)';
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * 7, r = 12 + Math.random() * 8;
    g.beginPath(); g.arc(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 2, 0, 7); g.fill();
  }
  return new THREE.CanvasTexture(cv);
}

const SURF = {
  dust: { color: '#b8a58a', n: 8, speed: 2.2, grav: -2, life: 0.5, size: 0.16 },
  dirt: { color: '#6b5138', n: 8, speed: 2.4, grav: -6, life: 0.6, size: 0.14 },
  spark: { color: '#ffd27a', n: 10, speed: 4.5, grav: -8, life: 0.3, size: 0.07 },
  wood: { color: '#a8794a', n: 10, speed: 3.2, grav: -9, life: 0.55, size: 0.1 },
  goo: { color: '#54d13a', n: 14, speed: 3.0, grav: -9, life: 0.7, size: 0.16 },
};

export class Effects {
  constructor(scene) {
    this.scene = scene;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.particles = [];
    const pTex = softTex('rgba(255,255,255,0.9)');
    for (let i = 0; i < 320; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: pTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false; scene.add(m);
      this.particles.push({ m, life: 0, max: 1, vel: new THREE.Vector3(), grav: 0, size: 0.1 });
    }
    this.pIdx = 0;
    this.decals = [];
    for (let i = 0; i < 100; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22),
        new THREE.MeshBasicMaterial({ map: holeTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.visible = false; scene.add(m);
      this.decals.push({ m, life: 0 });
    }
    this.dIdx = 0;
    this.shells = [];
    const shellGeo = new THREE.BoxGeometry(0.05, 0.02, 0.02);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xd9b23a, metalness: 0.8, roughness: 0.3 });
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(shellGeo, shellMat);
      m.visible = false; scene.add(m);
      this.shells.push({ m, life: 0, vel: new THREE.Vector3(), av: new THREE.Vector3(), settled: false });
    }
    this.sIdx = 0;
  }

  burst(pos, surf, dir) {
    const s = SURF[surf] || SURF.dust;
    for (let i = 0; i < s.n; i++) {
      const p = this.particles[this.pIdx]; this.pIdx = (this.pIdx + 1) % this.particles.length;
      p.m.visible = true;
      p.m.material.color.set(s.color);
      p.m.position.copy(pos);
      p.vel.set((Math.random() - 0.5), Math.random() * 0.8 + 0.2, (Math.random() - 0.5))
        .addScaledVector(dir || new THREE.Vector3(), -s.speed * 0.4)
        .multiplyScalar(s.speed * (0.5 + Math.random()));
      p.grav = s.grav; p.max = s.life * (0.7 + Math.random() * 0.6); p.life = p.max;
      p.size = s.size * (0.6 + Math.random() * 0.8);
    }
  }

  decal(pos, normal) {
    const d = this.decals[this.dIdx]; this.dIdx = (this.dIdx + 1) % this.decals.length;
    d.m.visible = true; d.m.position.copy(pos).addScaledVector(normal, 0.015);
    d.m.lookAt(pos.clone().add(normal));
    d.m.rotation.z = Math.random() * Math.PI * 2;
    d.m.material.opacity = 1; d.life = 12;
  }

  shell(pos, right, up) {
    const s = this.shells[this.sIdx]; this.sIdx = (this.sIdx + 1) % this.shells.length;
    s.m.visible = true; s.m.position.copy(pos); s.life = 5; s.settled = false;
    s.vel.copy(right).multiplyScalar(1.6 + Math.random()).addScaledVector(up, 1.8 + Math.random() * 0.6)
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4));
    s.av.set(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
  }

  update(dt) {
    for (const p of this.particles) {
      if (!p.m.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.m.visible = false; continue; }
      p.vel.y += p.grav * dt;
      p.m.position.addScaledVector(p.vel, dt);
      if (p.m.position.y < 0.02) { p.m.position.y = 0.02; p.vel.y *= -0.3; p.vel.x *= 0.7; p.vel.z *= 0.7; }
      const k = p.life / p.max;
      p.m.material.opacity = k;
      p.m.scale.setScalar(p.size * (1.4 - k * 0.6));
      p.m.quaternion.setFromRotationMatrix(this.scene.__camMat || p.m.matrix);
    }
    for (const d of this.decals) {
      if (!d.m.visible) continue;
      d.life -= dt;
      if (d.life <= 2) d.m.material.opacity = Math.max(0, d.life / 2);
      if (d.life <= 0) d.m.visible = false;
    }
    for (const s of this.shells) {
      if (!s.m.visible) continue;
      s.life -= dt;
      if (s.life <= 0) { s.m.visible = false; continue; }
      if (!s.settled) {
        s.vel.y -= 12 * dt;
        s.m.position.addScaledVector(s.vel, dt);
        s.m.rotation.x += s.av.x * dt; s.m.rotation.y += s.av.y * dt; s.m.rotation.z += s.av.z * dt;
        if (s.m.position.y < 0.015) {
          s.m.position.y = 0.015;
          if (Math.abs(s.vel.y) > 0.6) { s.vel.y *= -0.35; s.vel.x *= 0.6; s.vel.z *= 0.6; s.av.multiplyScalar(0.5); }
          else { s.settled = true; s.vel.set(0, 0, 0); }
        }
      }
      if (s.life < 1) s.m.material.transparent = true, s.m.material.opacity = s.life;
    }
  }
}
