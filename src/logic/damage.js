// Pure damage-by-hitbox rules. No Three.js.

export const LEG_DAMAGE_TO_CRAWL = 55; // leg damage threshold -> becomes crawler

export function zoneMultiplier(weapon, zone) {
  if (zone === 'head') return weapon.headMul;
  if (zone === 'legs') return weapon.legMul;
  return 1;
}

// zombie combat state: { hp, legHp, armHp, crawler, alive }
export function makeCombatStats(hp = 100) {
  return { hp, maxHp: hp, legHp: LEG_DAMAGE_TO_CRAWL, armHp: 60, crawler: false, alive: true, slowed: 0 };
}

// returns { dead, becameCrawler, armWeakened, damage }
export function applyHit(stats, weapon, zone) {
  if (!stats.alive) return { dead: false, damage: 0 };
  let dmg = weapon.dmg * zoneMultiplier(weapon, zone);
  if (stats.crawler && zone === 'legs') dmg *= 0.5; // legs already gone
  stats.hp -= dmg;
  let becameCrawler = false, armWeakened = false;
  if (zone === 'legs' && !stats.crawler) {
    stats.legHp -= weapon.dmg;
    stats.slowed = 0.55; // leg hits slow them
    if (stats.legHp <= 0) { stats.crawler = true; becameCrawler = true; }
  }
  if (zone === 'chest' || zone === 'head') {
    stats.armHp -= weapon.dmg * 0.5;
    if (stats.armHp <= 0) armWeakened = true; // weaker attacks
  }
  if (stats.hp <= 0) { stats.hp = 0; stats.alive = false; }
  return { dead: !stats.alive, becameCrawler, armWeakened, damage: dmg };
}

// brute armour: front shots (not head) reduced; back/head full
export function armourMul(armoured, hitFromBehind, zone) {
  if (!armoured) return 1;
  if (zone === 'head' || hitFromBehind) return 1;
  return 0.35;
}

export function scoreForKill(weapon, zone, combo) {
  const base = zone === 'head' ? 150 : 100;
  const comboMul = 1 + Math.min(combo, 10) * 0.1;
  return Math.round(base * comboMul);
}
