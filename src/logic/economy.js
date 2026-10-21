// Pure buy-station economy. No Three.js.

export const SHOP = [
  { id: 'ammo', name: 'Ammo Refill', cost: 100, desc: 'Top up current weapon' },
  { id: 'health', name: 'Health Kit', cost: 150, desc: '+50 HP' },
  { id: 'grenade', name: 'Grenade', cost: 120, desc: '+1 grenade' },
  { id: 'smg', name: 'Buy SMG', cost: 400, desc: 'Unlock SMG' },
  { id: 'shotgun', name: 'Buy Shotgun', cost: 600, desc: 'Unlock shotgun' },
  { id: 'rifle', name: 'Buy Rifle', cost: 900, desc: 'Unlock rifle' },
  { id: 'silencer', name: 'Silencer', cost: 500, desc: 'Halve gunshot noise' },
];

export function canBuy(item, score, state) {
  if (score < item.cost) return false;
  if (item.id === 'smg' && state.owned.smg) return false;
  if (item.id === 'shotgun' && state.owned.shotgun) return false;
  if (item.id === 'rifle' && state.owned.rifle) return false;
  if (item.id === 'silencer' && state.silencer) return false;
  return true;
}

export function applyPurchase(item, state) {
  switch (item.id) {
    case 'ammo': state.refill = true; break;
    case 'health': state.health = Math.min(100, state.health + 50); break;
    case 'grenade': state.grenades++; break;
    case 'smg': state.owned.smg = true; break;
    case 'shotgun': state.owned.shotgun = true; break;
    case 'rifle': state.owned.rifle = true; break;
    case 'silencer': state.silencer = true; break;
  }
}
