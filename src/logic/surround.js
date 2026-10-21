// Pure surround-slot claiming: zombies approach the player from different sides.

export const SLOT_COUNT = 8;

export function makeSlots() {
  return new Array(SLOT_COUNT).fill(null);
}

export function slotAngle(i) {
  return (i / SLOT_COUNT) * Math.PI * 2;
}

// claim the free slot nearest the zombie's current approach angle (relative to player)
export function claimSlot(slots, zombieId, approachAngle) {
  let best = -1, bestD = 1e9;
  let a = approachAngle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (slots[i] !== null) continue;
    let d = Math.abs(slotAngle(i) - (a + Math.PI));
    while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) slots[best] = zombieId;
  return best;
}

export function releaseSlot(slots, zombieId) {
  for (let i = 0; i < slots.length; i++) if (slots[i] === zombieId) slots[i] = null;
}

// world position of a slot around player
export function slotPos(slots, i, px, pz, radius) {
  const a = slotAngle(i);
  return { x: px + Math.sin(a) * radius, z: pz + Math.cos(a) * radius };
}

// group attack gating: only N attackers at once, others wait
export function attackToken(attackers, max) {
  return attackers < max;
}

// flanking: every 3rd zombie takes the long way around
export function shouldFlank(zombieIdx) {
  return zombieIdx % 3 === 2;
}
