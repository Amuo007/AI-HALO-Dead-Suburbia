// Pure map layout generation. No Three.js. Deterministic from seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAP_SIZE = 120;          // map spans [-60, 60]
export const STREET_W = 9;
export const STREETS_X = [-44, 0, 44]; // vertical streets at these x
export const STREETS_Z = [-44, 0, 44]; // horizontal streets at these z

// nominal footprints (x,z half-extents, height) used for nav/collision + tests
export const FOOTPRINTS = {
  'building-type-a': [4, 4, 4.2], 'building-type-b': [4, 5, 4.2],
  'building-type-c': [4, 4, 4.2], 'building-type-d': [5, 4, 4.2],
  'building-type-e': [4, 4, 4.6], 'building-type-f': [5, 5, 4.6],
  'building-type-g': [4, 4, 4.2], 'building-type-h': [3, 3, 3.6],
  'building-type-i': [3, 4, 3.6], 'building-type-j': [4, 4, 4.2],
  'building-type-k': [4, 3, 4.2], 'building-type-l': [5, 4, 4.6],
  'building-type-m': [4, 4, 4.2], 'building-type-n': [4, 5, 4.6],
  'building-type-o': [4, 4, 4.2], 'building-type-p': [3, 3, 3.6],
  'building-type-q': [4, 4, 4.2], 'building-type-r': [4, 4, 4.6],
  'building-type-s': [3, 4, 4.2], 'building-type-t': [4, 4, 4.2],
  'building-type-u': [4, 3, 3.6],
  'tree-large': [0.8, 0.8, 5], 'tree-small': [0.5, 0.5, 3],
  'planter': [0.7, 0.7, 0.6],
  'fence-low': [1.5, 0.15, 1.0], 'fence': [1.5, 0.15, 1.6],
  'fence-1x2': [1, 0.15, 1.6], 'fence-2x2': [2, 0.15, 1.6],
  'fence-3x2': [3, 0.15, 1.6],
};
const BUILDING_TYPES = Object.keys(FOOTPRINTS).filter(k => k.startsWith('building'));

export function generateMap(seed = 1) {
  const rnd = mulberry32(seed);
  const props = [];   // {model, x, z, rotY}
  const boxes = [];   // {x,z,hw,hd,h,solid:true,kind}
  const fences = [];  // {x,z,rotY,hp,hw,hd,h,low}
  const spawns = [];

  const addBox = (x, z, hw, hd, h, kind) => { boxes.push({ x, z, hw, hd, h, kind }); };

  // --- houses in the 4 inner blocks + outer park ring ---
  const blockCenters = [];
  for (const bx of [-22, 22]) for (const bz of [-22, 22]) blockCenters.push([bx, bz]);

  for (const [bx, bz] of blockCenters) {
    // 4 houses per block, one per side, facing the street
    const sides = [
      { dx: -8, dz: -12, rot: 0 }, { dx: 8, dz: -12, rot: 0 },
      { dx: -8, dz: 12, rot: Math.PI }, { dx: 8, dz: 12, rot: Math.PI },
    ];
    for (const s of sides) {
      const type = BUILDING_TYPES[Math.floor(rnd() * BUILDING_TYPES.length)];
      const [hw, hd, h] = FOOTPRINTS[type];
      const x = bx + s.dx, z = bz + s.dz;
      props.push({ model: type, x, z, rotY: s.rot });
      boxes.push({ x, z, hw, hd, h, kind: 'house', model: type });
      // planter by the door
      if (rnd() < 0.7) {
        const px = x + (rnd() - 0.5) * 3, pz = z + (s.rot === 0 ? hd + 1 : -hd - 1);
        props.push({ model: 'planter', x: px, z: pz, rotY: rnd() * 6 });
        addBox(px, pz, 0.7, 0.7, 0.6, 'planter');
      }
    }
    // yard fence around block with a gap in the middle of each side (driveways)
    const half = 16.5;
    const fenceSeg = (x, z, rotY) => {
      const low = rnd() < 0.45;
      const model = low ? 'fence-low' : 'fence';
      fences.push({ x, z, rotY, hp: low ? 40 : 80, hw: 1.5, hd: 0.2, h: low ? 1.0 : 1.6, low });
      props.push({ model, x, z, rotY });
    };
    const fenceSide = (cx, cz, rotY) => {
      const g = 3;
      for (let t = -half + 1.5; t < -g; t += 3) fenceSeg(rotY === 0 ? cx + t : cx, rotY === 0 ? cz : cz + t, rotY);
      for (let t = g + 1.5; t <= half - 1; t += 3) fenceSeg(rotY === 0 ? cx + t : cx, rotY === 0 ? cz : cz + t, rotY);
    };
    fenceSide(bx, bz - half, 0);
    fenceSide(bx, bz + half, 0);
    fenceSide(bx - half, bz, Math.PI / 2);
    fenceSide(bx + half, bz, Math.PI / 2);
  }

  // --- trees & planters scattered in park ring / between blocks ---
  const tryPlace = (model, hw, hd, h, kind, x0, z0, spread) => {
    for (let tries = 0; tries < 12; tries++) {
      const x = x0 + (rnd() - 0.5) * spread, z = z0 + (rnd() - 0.5) * spread;
      if (Math.abs(x) > 57 || Math.abs(z) > 57) continue;
      if (isOnStreet(x, z)) continue;
      let ok = true;
      for (const b of boxes) {
        if (Math.abs(x - b.x) < hw + b.hw + 1 && Math.abs(z - b.z) < hd + b.hd + 1) { ok = false; break; }
      }
      for (const f of fences) {
        if (Math.abs(x - f.x) < hw + 1.6 && Math.abs(z - f.z) < hd + 1.6) { ok = false; break; }
      }
      if (!ok) continue;
      props.push({ model, x, z, rotY: rnd() * 6 });
      addBox(x, z, hw, hd, h, kind);
      return true;
    }
    return false;
  };
  for (let i = 0; i < 26; i++) {
    const big = rnd() < 0.5;
    tryPlace(big ? 'tree-large' : 'tree-small', ...(big ? FOOTPRINTS['tree-large'] : FOOTPRINTS['tree-small']), 'tree',
      (rnd() - 0.5) * 110, (rnd() - 0.5) * 110, 14);
  }

  // --- spawn points along streets (edges of map + mid) ---
  for (const sx of STREETS_X) for (const sz of [-52, -22, 22, 52]) spawns.push({ x: sx, z: sz });
  for (const sz of STREETS_Z) for (const sx of [-22, 22]) spawns.push({ x: sx, z: sz });
  // dedupe
  const seen = new Set();
  const spawnsU = spawns.filter(s => { const k = s.x + ',' + s.z; if (seen.has(k)) return false; seen.add(k); return true; });

  return { size: MAP_SIZE, props, boxes, fences, spawns: spawnsU, seed };
}

export function isOnStreet(x, z) {
  for (const sx of STREETS_X) if (Math.abs(x - sx) < STREET_W / 2) return true;
  for (const sz of STREETS_Z) if (Math.abs(z - sz) < STREET_W / 2) return true;
  return false;
}
