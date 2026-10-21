// Pure AI director: Left 4 Dead style tension pacing. No Three.js.

export function createDirector() {
  return {
    wave: 0, phase: 'relax', phaseT: 0,
    health: 100, ammoFrac: 1, killRate: 0, killWindow: [],
    campX: 0, campZ: 0, campT: 0, camping: false,
    horde: false, pendingSpecials: 0,
  };
}

export function directorNoteKill(d, now) { d.killWindow.push(now); }

export function directorUpdate(d, dt, { health, ammoFrac, px, pz, time }) {
  d.health = health; d.ammoFrac = ammoFrac;
  d.killWindow = d.killWindow.filter(t => time - t < 8);
  d.killRate = d.killWindow.length;
  d.phaseT += dt;
  // camping detection
  const moved = Math.hypot(px - d.campX, pz - d.campZ);
  if (moved < 0.5) d.campT += dt; else { d.campT = 0; d.campX = px; d.campZ = pz; }
  d.camping = d.campT > 12;
  // build-up -> peak -> relax cycle
  if (d.phase === 'relax' && d.phaseT > 14) { d.phase = 'buildup'; d.phaseT = 0; }
  if (d.phase === 'buildup' && d.phaseT > 10) { d.phase = 'peak'; d.phaseT = 0; }
  if (d.phase === 'peak' && d.phaseT > 12) { d.phase = 'relax'; d.phaseT = 0; }
  if (d.camping) d.pendingSpecials = Math.max(d.pendingSpecials, 1);
}

export function waveComposition(wave) {
  const n = Math.min(5 + wave * 3, 26);
  const comp = { walker: n, runner: 0, brute: 0, screamer: 0, spitter: 0, bloater: 0 };
  if (wave >= 3) comp.runner = Math.floor(wave / 2);
  if (wave >= 4) comp.screamer = wave % 3 === 0 ? 1 : 0;
  if (wave >= 5) comp.spitter = Math.floor(wave / 4);
  if (wave >= 6) comp.brute = wave % 5 === 0 ? 2 : 1;
  if (wave >= 7) comp.bloater = wave % 4 === 0 ? 1 : 0;
  if (wave % 5 === 0) { comp.walker = n + 10; comp.horde = true; } // big horde every 5th wave
  return comp;
}

export function directorWantsHorde(wave) { return wave % 5 === 0; }

// supply drops when low
export function shouldDropSupply(d) {
  return d.health < 40 || d.ammoFrac < 0.2;
}

export function breakDuration(wave) { return 15; }
