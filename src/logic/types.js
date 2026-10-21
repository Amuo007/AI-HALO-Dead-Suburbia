// Pure zombie type definitions. No Three.js.

export const TYPES = {
  walker:   { hp: 100, speed: 1.0, tint: 0x9fb87a, size: 1.0, dmg: 10, attackRange: 1.9, attackCd: 1.6 },
  runner:   { hp: 80,  speed: 2.3, tint: 0xd8b24a, size: 1.0, dmg: 12, attackRange: 1.8, attackCd: 1.0, zigzag: true, minWave: 3 },
  crawler:  { hp: 60,  speed: 1.0, tint: 0x7a9f6a, size: 1.0, dmg: 8,  attackRange: 1.5, attackCd: 1.4, crawl: true },
  brute:    { hp: 340, speed: 0.7, tint: 0x6a7f9f, size: 1.4, dmg: 25, attackRange: 2.4, attackCd: 2.2, armour: true, charge: true, knockback: 9 },
  screamer: { hp: 120, speed: 1.1, tint: 0xc26ad8, size: 1.0, dmg: 8,  attackRange: 1.8, attackCd: 1.8, scream: true },
  spitter:  { hp: 110, speed: 0.9, tint: 0x4ad86a, size: 1.0, dmg: 14, attackRange: 1.8, attackCd: 2.0, ranged: true, keepDist: [8, 14] },
  bloater:  { hp: 240, speed: 0.6, tint: 0xd86a4a, size: 1.25, dmg: 40, attackRange: 2.2, attackCd: 99, explode: true },
};

export const TYPE_LIST = Object.keys(TYPES);

export function typeStats(id) { return TYPES[id] || TYPES.walker; }
