// Procedural Web Audio sound engine. No Three.js.

let ctx = null, master = null, noiseBuf = null;
let muted = false, vol = 0.8;
let droneGain = null, droneOsc = [];
let listener = null;

export function initAudio() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = vol;
  master.connect(ctx.destination);
  const len = ctx.sampleRate * 2;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  listener = ctx.listener;
  startDrone();
  return ctx;
}
export function setVolume(v) { vol = v; if (master) master.gain.value = muted ? 0 : v; }
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : vol; }
export function updateListener(camPos, fwd) {
  if (!listener || !listener.positionX) return;
  const t = ctx.currentTime;
  listener.positionX.value = camPos.x; listener.positionY.value = camPos.y; listener.positionZ.value = camPos.z;
  if (listener.forwardX) {
    listener.forwardX.value = fwd.x; listener.forwardY.value = fwd.y; listener.forwardZ.value = fwd.z;
    listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
  }
}

function noise(dur, freq, q, gain, type = 'bandpass') {
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(f).connect(g).connect(master);
  src.start(); src.stop(ctx.currentTime + dur + 0.02);
}
function tone(freq, dur, type = 'sine', gain = 0.1, slide = 0) {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), ctx.currentTime + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start(); o.stop(ctx.currentTime + dur + 0.02);
}
function panner(x, y, z) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
  else p.setPosition(x, y, z);
  p.distanceModel = 'inverse'; p.refDistance = 4; p.maxDistance = 60; p.rolloffFactor = 1.4;
  p.connect(master);
  return p;
}

export const sfx = {
  shot(id) {
    if (!ctx) return;
    if (id === 'shotgun') { noise(0.28, 900, 0.8, 0.5, 'lowpass'); tone(70, 0.25, 'sawtooth', 0.3, -40); }
    else if (id === 'rifle') { noise(0.14, 2200, 1.2, 0.35); tone(140, 0.1, 'square', 0.18, -80); }
    else if (id === 'smg') { noise(0.07, 2600, 1.5, 0.22); tone(200, 0.05, 'square', 0.1, -100); }
    else { noise(0.1, 1800, 1.2, 0.28); tone(180, 0.07, 'square', 0.14, -90); }
  },
  dry() { if (ctx) tone(1100, 0.03, 'square', 0.05); },
  emptyClick(pitch) { if (ctx) tone(pitch ? 1500 : 900, 0.03, 'square', 0.04); },
  hit() { if (ctx) { tone(600, 0.05, 'triangle', 0.08, -200); noise(0.04, 3000, 2, 0.06); } },
  headshot() { if (ctx) { tone(1200, 0.12, 'sine', 0.1, 400); tone(1800, 0.15, 'sine', 0.06); } },
  kill() { if (ctx) tone(240, 0.15, 'triangle', 0.1, -120); },
  reloadOut() { if (ctx) tone(500, 0.06, 'square', 0.05, -200); },
  reloadIn() { if (ctx) { tone(700, 0.05, 'square', 0.06); noise(0.05, 4000, 3, 0.04); } },
  clink() { if (ctx) { tone(2400 + Math.random() * 800, 0.06, 'triangle', 0.03); } },
  footstep(sprint) { if (ctx) noise(0.06, 300 + Math.random() * 100, 1, sprint ? 0.06 : 0.035, 'lowpass'); },
  groan(x, y, z) {
    if (!ctx) return;
    const p = panner(x, y, z);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = 70 + Math.random() * 50;
    o.frequency.setValueAtTime(f, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, ctx.currentTime + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 400;
    o.connect(fl).connect(g).connect(p);
    o.start(); o.stop(ctx.currentTime + 0.85);
  },
  scream() {
    if (!ctx) return;
    tone(900, 0.6, 'sawtooth', 0.15, 900);
    tone(1300, 0.5, 'square', 0.06, 700);
    noise(0.6, 3000, 2, 0.08);
  },
  roar() { if (ctx) { tone(60, 0.8, 'sawtooth', 0.25, -20); noise(0.7, 200, 1, 0.15, 'lowpass'); } },
  spit() { if (ctx) { tone(300, 0.25, 'sine', 0.08, -180); noise(0.2, 800, 1, 0.05); } },
  bloaterPop() { if (ctx) { noise(0.4, 400, 0.7, 0.4, 'lowpass'); tone(50, 0.4, 'sine', 0.3, -30); } },
  explosion() { if (ctx) { noise(0.7, 250, 0.6, 0.6, 'lowpass'); tone(45, 0.6, 'sine', 0.4, -20); } },
  hurt() { if (ctx) { tone(140, 0.25, 'triangle', 0.15, -60); noise(0.1, 600, 1, 0.08); } },
  woodBreak() { if (ctx) { noise(0.2, 700, 1, 0.2); tone(150, 0.15, 'square', 0.08, -60); } },
  melee() { if (ctx) { noise(0.1, 500, 1, 0.12); tone(200, 0.08, 'triangle', 0.08, -80); } },
  pickup() { if (ctx) { tone(660, 0.08, 'sine', 0.08); tone(990, 0.12, 'sine', 0.06); } },
  heartbeat() { if (ctx) { tone(55, 0.12, 'sine', 0.25); setTimeout(() => tone(50, 0.15, 'sine', 0.2), 140); } },
};

function startDrone() {
  droneGain = ctx.createGain();
  droneGain.gain.value = 0.02;
  droneGain.connect(master);
  for (const f of [55, 58.5, 110]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 180;
    o.connect(fl).connect(droneGain); o.start();
    droneOsc.push(o);
  }
}
export function setDroneIntensity(x) {
  if (droneGain) droneGain.gain.value = 0.015 + Math.min(0.5, x) * 0.06;
}
