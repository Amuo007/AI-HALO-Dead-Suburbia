// Pure weapon rules: stats, spread, recoil, ammo, reload, penetration. No Three.js.

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'PISTOL', model: 'blaster-a', slot: 1,
    dmg: 26, headMul: 2.5, legMul: 0.7, rate: 0.26, clip: 12, reserveMax: 120,
    spread: 0.005, moveSpread: 0.02, adsMul: 0.35, pellets: 1, auto: false,
    recoil: [[0.016, 0], [0.014, 0.004], [0.012, -0.004], [0.010, 0.002], [0.008, -0.002]],
    kick: 0.9, noise: 16, penetration: 0, reloadTime: 1.3, shake: 0.35, scope: false,
    price: 0, knockback: 2.2,
  },
  smg: {
    id: 'smg', name: 'SMG', model: 'blaster-c', slot: 2,
    dmg: 15, headMul: 2.0, legMul: 0.7, rate: 0.085, clip: 32, reserveMax: 256,
    spread: 0.016, moveSpread: 0.038, adsMul: 0.5, pellets: 1, auto: true,
    recoil: [[0.008, 0], [0.007, 0.003], [0.006, -0.003], [0.006, 0.002], [0.005, -0.002], [0.005, 0.001]],
    kick: 0.55, noise: 15, penetration: 0, reloadTime: 1.7, shake: 0.25, scope: false,
    price: 400, knockback: 1.4,
  },
  shotgun: {
    id: 'shotgun', name: 'SHOTGUN', model: 'blaster-m', slot: 3,
    dmg: 13, headMul: 1.6, legMul: 0.7, rate: 0.85, clip: 6, reserveMax: 48,
    spread: 0.05, moveSpread: 0.02, adsMul: 0.7, pellets: 8, auto: false,
    recoil: [[0.05, 0], [0.03, 0.01]],
    kick: 2.4, noise: 24, penetration: 0, reloadTime: 2.3, shake: 1.3, scope: false,
    price: 600, knockback: 6, knockdown: true,
  },
  rifle: {
    id: 'rifle', name: 'RIFLE', model: 'blaster-h', slot: 4,
    dmg: 34, headMul: 3.0, legMul: 0.7, rate: 0.17, clip: 20, reserveMax: 140,
    spread: 0.004, moveSpread: 0.03, adsMul: 0.2, pellets: 1, auto: true,
    recoil: [[0.02, 0], [0.017, 0.005], [0.014, -0.005], [0.012, 0.004], [0.010, -0.003]],
    kick: 1.5, noise: 26, penetration: 3, reloadTime: 2.1, shake: 0.7, scope: true,
    price: 900, knockback: 3,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun', 'rifle'];

export function createAmmo(id, owned = true) {
  const w = WEAPONS[id];
  return { id, owned, clip: w.clip, reserve: Math.floor(w.reserveMax * 0.6), reloading: false, reloadT: 0, cooldown: 0, recoilIdx: 0, chambered: true };
}

export function canFire(ammo, now) {
  if (!ammo.owned || ammo.reloading) return false;
  if (ammo.cooldown > 0) return false;
  return ammo.clip > 0;
}

export function fireShot(ammo) {
  ammo.clip--;
  ammo.cooldown = WEAPONS[ammo.id].rate;
  if (ammo.clip === 0) ammo.chambered = false;
  return ammo.clip;
}

// tactical reload keeps a round in the chamber when not empty
export function startReload(ammo) {
  const w = WEAPONS[ammo.id];
  if (ammo.reloading || ammo.clip >= w.clip || ammo.reserve <= 0) return false;
  ammo.reloading = true;
  ammo.reloadT = w.reloadTime;
  ammo.tactical = ammo.clip > 0;
  return true;
}

export function tickReload(ammo, dt) {
  if (!ammo.reloading) return false;
  ammo.reloadT -= dt;
  if (ammo.reloadT > 0) return false;
  const w = WEAPONS[ammo.id];
  const keep = ammo.tactical && ammo.clip > 0 ? 1 : 0; // chambered round stays
  const need = w.clip - keep;
  const take = Math.min(need, ammo.reserve);
  ammo.clip = keep + take;
  ammo.reserve -= take;
  ammo.reloading = false;
  ammo.chambered = true;
  return true;
}

export function tickCooldown(ammo, dt) {
  ammo.cooldown = Math.max(0, ammo.cooldown - dt);
}

// spread in radians
export function currentSpread(ammo, { moving, aiming, heat }) {
  const w = WEAPONS[ammo.id];
  let s = w.spread + heat * 0.004;
  if (moving) s += w.moveSpread;
  if (aiming) s *= w.adsMul;
  return s;
}

export function recoilStep(ammo) {
  const w = WEAPONS[ammo.id];
  const p = w.recoil[ammo.recoilIdx % w.recoil.length];
  ammo.recoilIdx++;
  return { pitch: p[0], yaw: p[1] };
}

export function resetRecoil(ammo) { ammo.recoilIdx = 0; }

// rifle penetrates up to N zombies in a line
export function penetrationCount(ammo) { return WEAPONS[ammo.id].penetration; }

export function lowAmmo(ammo) { return ammo.clip > 0 && ammo.clip <= Math.ceil(WEAPONS[ammo.id].clip * 0.25); }
