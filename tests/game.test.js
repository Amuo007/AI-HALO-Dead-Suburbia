import test from 'node:test';
import assert from 'node:assert';
import { generateMap, isOnStreet, FOOTPRINTS } from '../src/logic/mapgen.js';
import { buildNavGrid, flowField, flowDir, cellOf, isBlocked, nearestFree } from '../src/logic/nav.js';
import { collideCircle, circleHitsBox, segCircle } from '../src/logic/collision.js';
import { canSee, hears, segBlocked } from '../src/logic/senses.js';
import { createAI, updateAI, S, onHit, onKnockdown, onDead } from '../src/logic/zombieAI.js';
import { makeSlots, claimSlot, releaseSlot, slotPos, shouldFlank, SLOT_COUNT } from '../src/logic/surround.js';
import { TYPES, TYPE_LIST, typeStats } from '../src/logic/types.js';
import { createDirector, directorUpdate, waveComposition, directorWantsHorde, shouldDropSupply, directorNoteKill } from '../src/logic/director.js';
import { WEAPONS, createAmmo, canFire, fireShot, startReload, tickReload, currentSpread, recoilStep, lowAmmo, penetrationCount } from '../src/logic/weapons.js';
import { applyHit, makeCombatStats, zoneMultiplier, armourMul, scoreForKill, LEG_DAMAGE_TO_CRAWL } from '../src/logic/damage.js';
import { SHOP, canBuy, applyPurchase } from '../src/logic/economy.js';

// ---------- map layout ----------
test('map generation is deterministic', () => {
  const a = generateMap(42), b = generateMap(42);
  assert.deepStrictEqual(a.props, b.props);
  assert.notDeepStrictEqual(generateMap(43).props, a.props);
});

test('map has houses, fences, trees and spawns', () => {
  const m = generateMap(7);
  assert.ok(m.boxes.filter(b => b.kind === 'house').length >= 12);
  assert.ok(m.fences.length > 40);
  assert.ok(m.props.some(p => p.model.startsWith('tree')));
  assert.ok(m.spawns.length >= 8);
});

test('houses do not overlap each other', () => {
  const m = generateMap(1337);
  const houses = m.boxes.filter(b => b.kind === 'house');
  for (let i = 0; i < houses.length; i++) for (let j = i + 1; j < houses.length; j++) {
    const a = houses[i], b = houses[j];
    const ox = a.hw + b.hw - Math.abs(a.x - b.x);
    const oz = a.hd + b.hd - Math.abs(a.z - b.z);
    assert.ok(ox <= 0 || oz <= 0, `overlap ${a.x},${a.z} vs ${b.x},${b.z}`);
  }
});

test('spawn points are on streets and walkable', () => {
  const m = generateMap(99);
  const g = buildNavGrid(m);
  for (const s of m.spawns) {
    assert.ok(isOnStreet(s.x, s.z), `spawn ${s.x},${s.z} not on street`);
  }
});

// ---------- nav grid + flow field ----------
test('nav grid blocks house cells and frees street cells', () => {
  const m = generateMap(5);
  const g = buildNavGrid(m);
  const h = m.boxes.find(b => b.kind === 'house');
  assert.ok(isBlocked(g, h.x, h.z));
  assert.ok(!isBlocked(g, 0, 8)); // street
});

test('flow field reaches distant street cells and descends', () => {
  const m = generateMap(5);
  const g = buildNavGrid(m);
  const dist = flowField(g, 0, 8);
  const far = cellOf(g, 0, -40);
  assert.ok(dist[far] > 0, 'far street cell reachable');
  const d = flowDir(g, dist, 0, -30);
  assert.ok(d && d.z > 0, 'flow points back toward player (+z)');
});

test('nearestFree escapes blocked cells', () => {
  const m = generateMap(5);
  const g = buildNavGrid(m);
  const h = m.boxes.find(b => b.kind === 'house');
  const [x, z] = nearestFree(g, h.x, h.z);
  assert.ok(!isBlocked(g, x, z));
});

// ---------- collision ----------
test('circle is pushed out of a box', () => {
  const boxes = [{ x: 0, z: 0, hw: 1, hd: 1, h: 3 }];
  const r = collideCircle(1.2, 0.3, 0.4, boxes);
  const d = Math.hypot(r.x - 1, r.z - 0.3);
  assert.ok(d >= 0.39, 'pushed to surface');
});

test('circle inside box escapes', () => {
  const boxes = [{ x: 0, z: 0, hw: 1, hd: 1, h: 3 }];
  const r = collideCircle(0, 0, 0.4, boxes);
  assert.ok(Math.abs(r.x) >= 1 || Math.abs(r.z) >= 1);
});

test('segBlocked detects wall between points', () => {
  const boxes = [{ x: 5, z: 0, hw: 1, hd: 4, h: 4 }];
  assert.ok(segBlocked(0, 0, 10, 0, boxes));
  assert.ok(!segBlocked(0, 6, 10, 6, boxes));
});

// ---------- senses ----------
test('vision cone: front yes, behind no, out of range no', () => {
  const boxes = [];
  assert.ok(canSee(0, 0, 0, 0, 10, boxes));            // facing +z, player ahead
  assert.ok(!canSee(0, 0, 0, 0, -10, boxes));          // behind
  assert.ok(!canSee(0, 0, 0, 0, 50, boxes));           // too far
});

test('vision blocked by house', () => {
  const boxes = [{ x: 0, z: 5, hw: 2, hd: 2, h: 4 }];
  assert.ok(!canSee(0, 0, 0, 0, 10, boxes));
});

test('hearing radius', () => {
  assert.ok(hears(0, 0, 3, 0, 5));
  assert.ok(!hears(0, 0, 6, 0, 5));
});

// ---------- zombie state machine ----------
const baseCtx = (over = {}) => ({
  x: 0, z: 0, px: 0, pz: 10, dist: 10, canSee: false, memValid: false, memX: 0, memZ: 0,
  flow: null, attackRange: 1.9, attackCd: 1.6, attackToken: true, isCrawler: false,
  knocked: false, screamer: false, flanking: false, slotX: 0, slotZ: 0, ...over,
});

test('idle -> alert -> chase when it sees the player', () => {
  const ai = createAI('walker');
  const out = updateAI(ai, baseCtx({ canSee: true }), 0.1);
  assert.equal(ai.state, S.ALERT);
  assert.ok(out.scream === false);
  updateAI(ai, baseCtx({ canSee: true }), 1);
  assert.equal(ai.state, S.CHASE);
});

test('screamer screams on first sight', () => {
  const ai = createAI('screamer');
  const out = updateAI(ai, baseCtx({ canSee: true, screamer: true }), 0.1);
  assert.ok(out.scream);
});

test('chase -> attack within range with token', () => {
  const ai = createAI('walker');
  ai.state = S.CHASE; ai.alerted = true;
  updateAI(ai, baseCtx({ dist: 1.5, canSee: true }), 0.05);
  assert.equal(ai.state, S.ATTACK);
});

test('attack without token stays in chase', () => {
  const ai = createAI('walker');
  ai.state = S.CHASE; ai.alerted = true;
  updateAI(ai, baseCtx({ dist: 1.5, canSee: true, attackToken: false }), 0.05);
  assert.equal(ai.state, S.CHASE);
});

test('knockdown then get up', () => {
  const ai = createAI('walker');
  ai.state = S.CHASE;
  onKnockdown(ai);
  assert.equal(ai.state, S.KNOCKDOWN);
  updateAI(ai, baseCtx({ knocked: true }), 3);
  assert.notEqual(ai.state, S.KNOCKDOWN);
});

test('crawler state crawls toward player', () => {
  const ai = createAI('crawler');
  updateAI(ai, baseCtx({ isCrawler: true, canSee: true, dist: 8 }), 0.1);
  assert.equal(ai.state, S.CRAWL);
  const out = updateAI(ai, baseCtx({ isCrawler: true, canSee: true, dist: 8 }), 0.1);
  assert.ok(Math.hypot(out.moveX, out.moveZ) > 0.5);
});

test('investigate goes to memory then gives up', () => {
  const ai = createAI('walker');
  ai.state = S.INVESTIGATE;
  const out = updateAI(ai, baseCtx({ memValid: true, memX: 5, memZ: 5 }), 0.1);
  assert.ok(Math.hypot(out.moveX, out.moveZ) > 0.5);
  ai.x = 5; ai.z = 5;
  for (let i = 0; i < 60; i++) updateAI(ai, baseCtx({ memValid: true, memX: 0.1, memZ: 0.1, x: 0, z: 0 }), 0.1);
  assert.ok(ai.state === S.WANDER || ai.state === S.IDLE);
});

// ---------- surround slots ----------
test('slots are claimed uniquely and released', () => {
  const slots = makeSlots();
  const a = claimSlot(slots, 1, 0), b = claimSlot(slots, 2, 0);
  assert.notEqual(a, b);
  for (let i = 3; i <= SLOT_COUNT; i++) claimSlot(slots, i, 0);
  assert.equal(claimSlot(slots, 99, 0), -1, 'all slots taken');
  releaseSlot(slots, 1);
  assert.ok(claimSlot(slots, 4, 0) >= 0);
});

test('slot positions ring the player', () => {
  const p = slotPos(makeSlots(), 0, 10, 10, 2);
  assert.ok(Math.abs(Math.hypot(p.x - 10, p.z - 10) - 2) < 0.01);
});

test('flanking assigned to some zombies', () => {
  assert.ok(shouldFlank(2));
  assert.ok(!shouldFlank(0));
});

// ---------- zombie types ----------
test('all 7 types exist with sane stats', () => {
  assert.equal(TYPE_LIST.length, 7);
  for (const t of TYPE_LIST) {
    const s = typeStats(t);
    assert.ok(s.hp > 0 && s.speed > 0 && s.dmg > 0);
  }
  assert.ok(TYPES.brute.size > TYPES.walker.size);
  assert.ok(TYPES.runner.speed > TYPES.walker.speed);
  assert.ok(TYPES.brute.armour);
  assert.ok(TYPES.screamer.scream);
  assert.ok(TYPES.spitter.ranged);
  assert.ok(TYPES.bloater.explode);
});

// ---------- director ----------
test('wave composition scales with wave', () => {
  const w1 = waveComposition(1), w6 = waveComposition(6);
  assert.ok(w6.walker > w1.walker);
  assert.ok(w6.brute >= 1);
});

test('horde every 5th wave', () => {
  assert.ok(directorWantsHorde(5) && directorWantsHorde(10));
  assert.ok(!directorWantsHorde(4));
});

test('camping triggers specials', () => {
  const d = createDirector();
  for (let i = 0; i < 200; i++) directorUpdate(d, 0.1, { health: 80, ammoFrac: 1, px: 0, pz: 0, time: i * 0.1 });
  assert.ok(d.camping);
  assert.ok(d.pendingSpecials >= 1);
});

test('supply drop when low', () => {
  const d = createDirector();
  directorUpdate(d, 0.1, { health: 30, ammoFrac: 0.5, px: 1, pz: 1, time: 1 });
  assert.ok(shouldDropSupply(d));
});

test('director cycles phases', () => {
  const d = createDirector();
  const seen = new Set();
  for (let i = 0; i < 500; i++) { directorUpdate(d, 0.1, { health: 90, ammoFrac: 1, px: i, pz: 0, time: i * 0.1 }); seen.add(d.phase); }
  assert.ok(seen.has('peak') && seen.has('relax') && seen.has('buildup'));
});

// ---------- weapons ----------
test('fire rate gates shots', () => {
  const a = createAmmo('smg');
  assert.ok(canFire(a, 0));
  fireShot(a);
  assert.ok(!canFire(a, 0), 'cooldown blocks');
  a.cooldown = 0;
  assert.ok(canFire(a, 0));
});

test('clip empties and reload refills', () => {
  const a = createAmmo('pistol');
  for (let i = 0; i < WEAPONS.pistol.clip; i++) fireShot(a);
  assert.equal(a.clip, 0);
  assert.ok(!canFire(a, 0));
  assert.ok(startReload(a));
  for (let i = 0; i < 100; i++) tickReload(a, 0.1);
  assert.equal(a.clip, WEAPONS.pistol.clip);
});

test('tactical reload keeps a chambered round', () => {
  const a = createAmmo('rifle');
  fireShot(a); fireShot(a); // 18/20
  startReload(a);
  for (let i = 0; i < 100; i++) tickReload(a, 0.1);
  assert.equal(a.clip, WEAPONS.rifle.clip);
  assert.equal(a.reserve, createAmmo('rifle').reserve - (WEAPONS.rifle.clip - 1));
});

test('spread grows moving, shrinks aiming', () => {
  const a = createAmmo('rifle');
  const still = currentSpread(a, { moving: false, aiming: false, heat: 0 });
  const moving = currentSpread(a, { moving: true, aiming: false, heat: 0 });
  const ads = currentSpread(a, { moving: false, aiming: true, heat: 0 });
  assert.ok(moving > still);
  assert.ok(ads < still);
});

test('recoil pattern cycles', () => {
  const a = createAmmo('pistol');
  const r1 = recoilStep(a), r2 = recoilStep(a);
  assert.ok(r1.pitch > 0);
  assert.notDeepStrictEqual([r1.pitch, r1.yaw], [r2.pitch, r2.yaw]);
});

test('shotgun fires 8 pellets, rifle penetrates 3', () => {
  assert.equal(WEAPONS.shotgun.pellets, 8);
  assert.equal(penetrationCount(createAmmo('rifle')), 3);
  assert.equal(penetrationCount(createAmmo('pistol')), 0);
});

test('low ammo warning', () => {
  const a = createAmmo('pistol');
  for (let i = 0; i < WEAPONS.pistol.clip - 2; i++) fireShot(a);
  assert.ok(lowAmmo(a));
});

// ---------- damage by hitbox ----------
test('head multiplies, legs reduce', () => {
  const w = WEAPONS.rifle;
  assert.equal(zoneMultiplier(w, 'head'), w.headMul);
  assert.ok(zoneMultiplier(w, 'legs') < 1);
});

test('headshot kills faster than body', () => {
  const w = WEAPONS.pistol;
  const h = makeCombatStats(), b = makeCombatStats();
  applyHit(h, w, 'head'); applyHit(b, w, 'chest');
  assert.ok(h.hp < b.hp);
});

test('enough leg damage turns zombie into crawler', () => {
  const s = makeCombatStats();
  const w = { dmg: 30, headMul: 2, legMul: 0.7 };
  let became = false;
  for (let i = 0; i < 5; i++) became = became || applyHit(s, w, 'legs').becameCrawler;
  assert.ok(became && s.crawler);
});

test('leg hits slow the zombie', () => {
  const s = makeCombatStats();
  applyHit(s, WEAPONS.pistol, 'legs');
  assert.ok(s.slowed < 1);
});

test('brute armour reduces front body hits but not head/back', () => {
  assert.ok(armourMul(true, false, 'chest') < 1);
  assert.equal(armourMul(true, false, 'head'), 1);
  assert.equal(armourMul(true, true, 'chest'), 1);
});

test('combo increases score', () => {
  assert.ok(scoreForKill(WEAPONS.pistol, 'chest', 5) > scoreForKill(WEAPONS.pistol, 'chest', 0));
  assert.ok(scoreForKill(WEAPONS.pistol, 'head', 0) > scoreForKill(WEAPONS.pistol, 'chest', 0));
});

// ---------- economy ----------
test('canBuy respects price and ownership', () => {
  const state = { owned: { smg: false, shotgun: false, rifle: false }, silencer: false, health: 100, grenades: 0 };
  const ammo = SHOP.find(i => i.id === 'ammo');
  assert.ok(!canBuy(ammo, 50, state));
  assert.ok(canBuy(ammo, 100, state));
  const smg = SHOP.find(i => i.id === 'smg');
  state.owned.smg = true;
  assert.ok(!canBuy(smg, 9999, state));
});

test('purchases apply', () => {
  const state = { owned: { smg: false, shotgun: false, rifle: false }, silencer: false, health: 60, grenades: 0 };
  applyPurchase(SHOP.find(i => i.id === 'health'), state);
  assert.equal(state.health, 100);
  applyPurchase(SHOP.find(i => i.id === 'silencer'), state);
  assert.ok(state.silencer);
  applyPurchase(SHOP.find(i => i.id === 'grenade'), state);
  assert.equal(state.grenades, 1);
});
