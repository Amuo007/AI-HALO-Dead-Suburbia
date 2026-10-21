// Pure zombie state machine. No Three.js.
// States: idle, wander, investigate, alert, chase, flank, attack, stagger, knockdown, crawl, dead

export const S = {
  IDLE: 'idle', WANDER: 'wander', INVESTIGATE: 'investigate', ALERT: 'alert',
  CHASE: 'chase', FLANK: 'flank', ATTACK: 'attack', STAGGER: 'stagger',
  KNOCKDOWN: 'knockdown', CRAWL: 'crawl', DEAD: 'dead',
};

export function createAI(type) {
  return {
    state: S.IDLE, t: 0, type,
    wanderX: 0, wanderZ: 0, searchT: 0,
    attackCd: 0, screamCd: 0,
    slot: -1, flanking: false,
    stuckT: 0, lastX: 0, lastZ: 0,
    alerted: false,
  };
}

function setState(ai, s) { ai.state = s; ai.t = 0; }

// ctx: { dist, canSee, memValid, memX, memZ, flow:{x,z}|null, attackRange, speedMul,
//        hasSlot, slotX, slotZ, attackToken, isCrawler, knocked, playerNear }
export function updateAI(ai, ctx, dt, rnd = Math.random) {
  ai.t += dt;
  ai.attackCd = Math.max(0, ai.attackCd - dt);
  ai.screamCd = Math.max(0, ai.screamCd - dt);
  const out = { moveX: 0, moveZ: 0, wantAttack: false, scream: false, speed: 1 };

  if (ai.state === S.DEAD) return out;
  if (ctx.knocked && ai.state !== S.KNOCKDOWN && ai.state !== S.CRAWL) setState(ai, S.KNOCKDOWN);
  if (ctx.isCrawler && ai.state !== S.CRAWL && ai.state !== S.DEAD) setState(ai, S.CRAWL);

  // perception transitions
  if (ctx.canSee && ai.state !== S.ATTACK && ai.state !== S.STAGGER && ai.state !== S.KNOCKDOWN && ai.state !== S.CRAWL) {
    if (!ai.alerted) {
      ai.alerted = true;
      if (ctx.screamer && ai.screamCd <= 0) { out.scream = true; ai.screamCd = 8; }
      setState(ai, S.ALERT);
    } else if (ai.state === S.IDLE || ai.state === S.WANDER || ai.state === S.INVESTIGATE || ai.state === S.ALERT) {
      setState(ai, ctx.flanking && ctx.dist > 6 ? S.FLANK : S.CHASE);
    }
  }

  switch (ai.state) {
    case S.IDLE:
      if (ai.t > 1.5 + rnd() * 2) { setState(ai, S.WANDER); ai.wanderX = ctx.x + (rnd() - 0.5) * 20; ai.wanderZ = ctx.z + (rnd() - 0.5) * 20; }
      break;
    case S.WANDER: {
      const dx = ai.wanderX - ctx.x, dz = ai.wanderZ - ctx.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2 || ai.t > 8) { setState(ai, S.IDLE); }
      else { out.moveX = dx / d; out.moveZ = dz / d; out.speed = 0.45; }
      break;
    }
    case S.ALERT:
      if (ai.t > 0.4) setState(ai, ctx.flanking && ctx.dist > 6 ? S.FLANK : S.CHASE);
      break;
    case S.INVESTIGATE: {
      if (!ctx.memValid) { setState(ai, S.WANDER); break; }
      const dx = ctx.memX - ctx.x, dz = ctx.memZ - ctx.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.5) {
        ai.searchT += dt;
        // look around
        out.moveX = Math.cos(ai.t * 2) * 0.3; out.moveZ = Math.sin(ai.t * 2) * 0.3; out.speed = 0.4;
        if (ai.searchT > 4) { ai.searchT = 0; setState(ai, S.WANDER); }
      } else {
        out.moveX = dx / d; out.moveZ = dz / d; out.speed = 0.8;
        if (ctx.flow) { out.moveX = ctx.flow.x; out.moveZ = ctx.flow.z; }
      }
      break;
    }
    case S.CHASE: {
      if (ctx.dist < ctx.attackRange && ctx.attackToken) { setState(ai, S.ATTACK); break; }
      const tx = ctx.canSee ? ctx.px : (ctx.memValid ? ctx.memX : ctx.px);
      const tz = ctx.canSee ? ctx.pz : (ctx.memValid ? ctx.memZ : ctx.pz);
      if (ctx.flow && (!ctx.canSee || ctx.dist > 4)) { out.moveX = ctx.flow.x; out.moveZ = ctx.flow.z; }
      else {
        const dx = tx - ctx.x, dz = tz - ctx.z, d = Math.hypot(dx, dz) || 1;
        out.moveX = dx / d; out.moveZ = dz / d;
      }
      // slow down on arrival
      if (ctx.dist < 2.5) out.speed = 0.6;
      if (!ctx.canSee && ctx.memValid === false && ctx.dist > 30) setState(ai, S.WANDER);
      break;
    }
    case S.FLANK: {
      if (ctx.dist < 5 || !ctx.flanking) { setState(ai, S.CHASE); break; }
      const dx = ctx.slotX - ctx.x, dz = ctx.slotZ - ctx.z, d = Math.hypot(dx, dz) || 1;
      out.moveX = dx / d; out.moveZ = dz / d;
      break;
    }
    case S.ATTACK:
      if (ai.t > 0.01 && ai.attackCd <= 0) { out.wantAttack = true; ai.attackCd = ctx.attackCd || 1.6; }
      if (ai.t > 0.8) setState(ai, S.CHASE);
      if (ctx.dist > ctx.attackRange * 1.6) setState(ai, S.CHASE);
      break;
    case S.STAGGER:
      if (ai.t > 0.6) setState(ai, ctx.canSee ? S.CHASE : S.INVESTIGATE);
      break;
    case S.KNOCKDOWN:
      if (ai.t > 2.2) { ai.knockTarget = 0; setState(ai, ctx.canSee ? S.CHASE : S.INVESTIGATE); }
      break;
    case S.CRAWL: {
      if (ctx.dist < ctx.attackRange && ctx.attackToken) { setState(ai, S.ATTACK); break; }
      if (ctx.flow) { out.moveX = ctx.flow.x; out.moveZ = ctx.flow.z; }
      else {
        const dx = ctx.px - ctx.x, dz = ctx.pz - ctx.z, d = Math.hypot(dx, dz) || 1;
        out.moveX = dx / d; out.moveZ = dz / d;
      }
      out.speed = 0.8;
      break;
    }
  }
  // stuck detection
  const moved = Math.hypot(ctx.x - ai.lastX, ctx.z - ai.lastZ);
  if (moved < 0.02 * dt * 60) ai.stuckT += dt; else ai.stuckT = 0;
  ai.lastX = ctx.x; ai.lastZ = ctx.z;
  out.stuck = ai.stuckT > 5;
  return out;
}

export function onHit(ai) {
  if (ai.state === S.DEAD) return;
  if (ai.state !== S.KNOCKDOWN) setState(ai, S.STAGGER);
}
export function onKnockdown(ai) { setState(ai, S.KNOCKDOWN); }
export function onDead(ai) { setState(ai, S.DEAD); }
