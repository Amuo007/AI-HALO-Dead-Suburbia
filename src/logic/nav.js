// Pure navigation grid + flow field (BFS). No Three.js.

export function buildNavGrid(map, cell = 1, inflate = 0.35) {
  const size = map.size;
  const w = Math.ceil(size / cell), h = w;
  const ox = -size / 2, oz = -size / 2;
  const blocked = new Uint8Array(w * h);
  const blockBox = (x, z, hw, hd) => {
    const x0 = Math.floor((x - hw - inflate - ox) / cell), x1 = Math.ceil((x + hw + inflate - ox) / cell);
    const z0 = Math.floor((z - hd - inflate - oz) / cell), z1 = Math.ceil((z + hd + inflate - oz) / cell);
    for (let gz = Math.max(0, z0); gz < Math.min(h, z1); gz++)
      for (let gx = Math.max(0, x0); gx < Math.min(w, x1); gx++)
        blocked[gz * w + gx] = 1;
  };
  for (const b of map.boxes) blockBox(b.x, b.z, b.hw, b.hd);
  for (const f of map.fences) {
    const rot = Math.abs(Math.sin(f.rotY)) > 0.5;
    blockBox(f.x, f.z, rot ? f.hd : f.hw, rot ? f.hw : f.hd);
  }
  // boundary wall
  for (let i = 0; i < w; i++) { blocked[i] = 1; blocked[(h - 1) * w + i] = 1; blocked[i * w] = 1; blocked[i * w + w - 1] = 1; }
  return { w, h, cell, ox, oz, blocked, map };
}

export function cellOf(grid, x, z) {
  const gx = Math.floor((x - grid.ox) / grid.cell), gz = Math.floor((z - grid.oz) / grid.cell);
  if (gx < 0 || gz < 0 || gx >= grid.w || gz >= grid.h) return -1;
  return gz * grid.w + gx;
}
export function isBlocked(grid, x, z) {
  const c = cellOf(grid, x, z);
  return c < 0 || grid.blocked[c] === 1;
}
// find nearest free cell to (x,z) via small spiral search
export function nearestFree(grid, x, z) {
  if (!isBlocked(grid, x, z)) return [x, z];
  const c = cellOf(grid, x, z);
  const cx = c % grid.w, cz = Math.floor(c / grid.w);
  for (let r = 1; r < 12; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gz < 0 || gx >= grid.w || gz >= grid.h) continue;
      if (!grid.blocked[gz * grid.w + gx]) {
        return [grid.ox + (gx + 0.5) * grid.cell, grid.oz + (gz + 0.5) * grid.cell];
      }
    }
  }
  return [x, z];
}

// BFS distance field from target cell; returns Int32Array dist (-1 = unreachable)
export function flowField(grid, tx, tz) {
  const { w, h, blocked } = grid;
  const dist = new Int32Array(w * h).fill(-1);
  let start = cellOf(grid, tx, tz);
  if (start < 0 || blocked[start]) {
    const [fx, fz] = nearestFree(grid, tx, tz);
    start = cellOf(grid, fx, fz);
    if (start < 0) return dist;
  }
  const q = new Int32Array(w * h);
  let qh = 0, qt = 0;
  q[qt++] = start; dist[start] = 0;
  while (qh < qt) {
    const c = q[qh++];
    const cx = c % w, cz = (c / w) | 0;
    const d = dist[c] + 1;
    const nb = [c - 1, c + 1, c - w, c + w];
    for (let i = 0; i < 4; i++) {
      const n = nb[i];
      if (i === 0 && cx === 0) continue;
      if (i === 1 && cx === w - 1) continue;
      if (n < 0 || n >= w * h) continue;
      if (blocked[n] || dist[n] !== -1) continue;
      dist[n] = d; q[qt++] = n;
    }
  }
  return dist;
}

// desired direction (unit vector) at world pos following decreasing dist
export function flowDir(grid, dist, x, z) {
  const c = cellOf(grid, x, z);
  if (c < 0 || dist[c] < 0) return null;
  const w = grid.w;
  const cx = c % w, cz = (c / w) | 0;
  let best = dist[c], bx = 0, bz = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    const gx = cx + dx, gz = cz + dz;
    if (gx < 0 || gz < 0 || gx >= grid.w || gz >= grid.h) continue;
    const n = dist[gz * grid.w + gx];
    if (n >= 0 && n < best) { best = n; bx = dx; bz = dz; }
  }
  if (bx === 0 && bz === 0) return null; // at target or no descent
  return { x: bx, z: bz };
}
