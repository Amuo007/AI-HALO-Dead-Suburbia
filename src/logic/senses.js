// Pure senses: vision cone, hearing, memory. No Three.js.

export const VISION_FOV = 110 * Math.PI / 180;
export const VISION_RANGE = 30;
export const FLASHLIGHT_BONUS = 1.35; // flashlight makes you easier to see (range multiplier)

// 2D segment vs AABB (boxes: {x,z,hw,hd}) — sample-based, cheap
export function segBlocked(x1, z1, x2, z2, boxes) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 0.8));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = x1 + dx * t, pz = z1 + dz * t;
    for (const b of boxes) {
      if (Math.abs(px - b.x) < b.hw && Math.abs(pz - b.z) < b.hd) return true;
    }
  }
  return false;
}

// can zombie at (zx,zz) facing fYaw see player at (px,pz)?
export function canSee(zx, zz, fYaw, px, pz, boxes, flashlight = false) {
  const dx = px - zx, dz = pz - zz;
  const d = Math.hypot(dx, dz);
  const range = VISION_RANGE * (flashlight ? FLASHLIGHT_BONUS : 1);
  if (d > range) return false;
  if (d < 1.5) return true;
  const ang = Math.atan2(dx, dz); // world yaw toward player (z-forward convention)
  let diff = ang - fYaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) > VISION_FOV / 2) return false;
  return !segBlocked(zx, zz, px, pz, boxes);
}

// hearing: is a sound at (sx,sz) with radius r heard by zombie at (zx,zz)?
export function hears(zx, zz, sx, sz, radius) {
  const dx = zx - sx, dz = zz - sz;
  return dx * dx + dz * dz <= radius * radius;
}

export function makeMemory() {
  return { x: 0, z: 0, valid: false, age: 0 };
}

export function updateMemory(mem, x, z, dt, seen) {
  mem.age += dt;
  if (seen) { mem.x = x; mem.z = z; mem.valid = true; mem.age = 0; }
  return mem;
}
