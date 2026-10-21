// Pure cheap collision: circles vs axis-aligned boxes. No Three.js.

// Resolve a moving circle against boxes; mutates and returns {x,z,onGround?}
export function collideCircle(x, z, r, boxes) {
  let px = x, pz = z;
  for (const b of boxes) {
    const dx = px - b.x, dz = pz - b.z;
    const qx = Math.max(-b.hw, Math.min(b.hw, dx));
    const qz = Math.max(-b.hd, Math.min(b.hd, dz));
    const nx = px - (b.x + qx), nz = pz - (b.z + qz);
    const d2 = nx * nx + nz * nz;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        px = b.x + qx + (nx / d) * r;
        pz = b.z + qz + (nz / d) * r;
      } else {
        // center inside box: push out along smallest axis
        const ox = b.hw - Math.abs(dx), oz = b.hd - Math.abs(dz);
        if (ox < oz) px = b.x + Math.sign(dx || 1) * (b.hw + r);
        else pz = b.z + Math.sign(dz || 1) * (b.hd + r);
      }
    }
  }
  return { x: px, z: pz };
}

export function circleHitsBox(x, z, r, b) {
  const qx = Math.max(-b.hw, Math.min(b.hw, x - b.x));
  const qz = Math.max(-b.hd, Math.min(b.hd, z - b.z));
  const nx = x - (b.x + qx), nz = z - (b.z + qz);
  return nx * nx + nz * nz < r * r;
}

// 2D segment vs circle (for raycast-ish checks like line-of-sight on grid)
export function segCircle(x1, z1, x2, z2, cx, cz, r) {
  const dx = x2 - x1, dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((cx - x1) * dx + (cz - z1) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + dx * t - cx, pz = z1 + dz * t - cz;
  return px * px + pz * pz < r * r;
}
