/**
 * Duplicated-region (copy-move) screening — part of MODULE 9.
 *
 * Detects areas of a page image that were copied and pasted elsewhere on the same
 * page (e.g. a signature, stamp, word or figure duplicated to alter a document).
 * Method (after Fridrich et al., 2003, block-matching copy-move detection):
 *   1. downscale to ≤ 700 px; slide B×B blocks with a small step;
 *   2. describe each textured block by 16 quantised sub-block means + contrast;
 *   3. sort descriptors lexicographically so similar blocks become neighbours;
 *   4. pair near-identical blocks that are far apart and vote for their shift vector;
 *   5. shift vectors supported by many spatially coherent blocks form a region pair;
 *   6. a genuine paste matches almost everywhere inside the region, so the share of textured
 *      blocks that matched (density) must be high;
 *   7. each candidate is confirmed by normalised cross-correlation of the two regions' pixels.
 *
 * Born-digital and rendered pages repeat words pixel-for-pixel, so a duplicate must be
 * taller than ~2 text lines (line height comes from preprocessing) to be reported.
 *
 * Limits: identical content can be legitimate (repeated logos, letterheads, form
 * fields, tables); heavy compression, rescaling or rotation of the pasted region can
 * hide a duplicate; content pasted from ANOTHER image (splicing) is not detected.
 */
import { downscale, boxBlur, round } from './imaging.js';

export const TAMPER_DEFAULTS = Object.freeze({
  maxSide: 700,        // analysis size (integer binning, so the actual size is ≤ this)
  block: 12,
  step: 1,
  minBlockStd: 14,     // skip flat paper
  quant: 6,            // descriptor quantisation (grey levels)
  neighbours: 24,      // compare with this many sorted neighbours
  link: 6,             // px: matched blocks closer than this belong to the same region
  maxDiff: 2,          // per-component tolerance after quantisation
  minDistance: 30,     // px at analysis scale; nearer pairs are self-similar texture
  minVotes: 100,       // blocks that must agree on one shift
  minExtent: 30,       // px at analysis scale: the region must be at least this wide AND tall
  lineHeight: 0,       // page px; when known, regions must also span ≥ minLines text lines
  minLines: 1.6,       // repeated words in born-digital pages are pixel-identical — ignore line-sized repeats
  minCorrelation: 0.9, // pixel correlation between the two regions required to confirm a copy
  minDensity: 0.8,     // share of textured blocks inside the region that must reappear at the shift
});

/**
 * @param {{width,height,data}} gray
 * @returns {{regions: Array, analysed: {width,height,scale}, blocks: number}}
 */
export function detectDuplicatedRegions(gray, opts = {}) {
  const o = { ...TAMPER_DEFAULTS, ...opts };
  // Integer-factor binning keeps a pasted copy's resampling phase to at most k variants,
  // and a light blur makes block descriptors tolerant of the remaining sub-pixel offset.
  const k = Math.max(1, Math.ceil(Math.max(gray.width, gray.height) / o.maxSide));
  const binned = k > 1 ? downscale(gray, Math.floor(Math.max(gray.width, gray.height) / k)) : gray;
  const img = boxBlur(binned);
  const scale = gray.width / img.width;
  const { width: w, height: h, data } = img;
  const B = o.block;
  const cell = B / 4;
  const feats = [];
  const pos = [];
  for (let y = 0; y + B <= h; y += o.step) {
    for (let x = 0; x + B <= w; x += o.step) {
      let s = 0;
      let q = 0;
      const f = new Int16Array(17);
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          let cs = 0;
          for (let yy = 0; yy < cell; yy++) for (let xx = 0; xx < cell; xx++) {
            const v = data[(y + cy * cell + yy) * w + x + cx * cell + xx];
            cs += v; s += v; q += v * v;
          }
          f[cy * 4 + cx] = Math.round(cs / (cell * cell) / o.quant);
        }
      }
      const n = B * B;
      const sd = Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
      if (sd < o.minBlockStd) continue;
      f[16] = Math.round(sd / o.quant);
      feats.push(f);
      pos.push([x, y]);
    }
  }
  const order = feats.map((_, i) => i).sort((a, b) => {
    const fa = feats[a]; const fb = feats[b];
    for (let k = 0; k < 17; k++) if (fa[k] !== fb[k]) return fa[k] - fb[k];
    return 0;
  });

  const votes = new Map();
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < Math.min(order.length, i + 1 + o.neighbours); j++) {
      const b = order[j];
      let ok = true;
      for (let k = 0; k < 17; k++) if (Math.abs(feats[a][k] - feats[b][k]) > o.maxDiff) { ok = false; break; }
      if (!ok) continue;
      let dx = pos[b][0] - pos[a][0];
      let dy = pos[b][1] - pos[a][1];
      if (Math.hypot(dx, dy) < o.minDistance) continue;
      let from = a; let to = b;
      if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; from = b; to = a; }
      const key = `${Math.round(dx / 2)},${Math.round(dy / 2)}`; // tolerate ±1 px jitter
      if (!votes.has(key)) votes.set(key, []);
      votes.get(key).push([from, to]);
    }
  }

  const regions = [];
  for (const [key, pairs] of votes) {
    if (pairs.length < o.minVotes) continue;
    // Keep the largest spatially coherent cluster of source blocks (8-neighbourhood on the block grid).
    const cluster = largestCluster(pairs.map(([s]) => pos[s]), o.link);
    if (cluster.length < o.minVotes) continue;
    const keep = new Set(cluster);
    const src = pairs.filter((_, i) => keep.has(i));
    const box = (ids) => {
      const xs = ids.map((id) => pos[id][0]);
      const ys = ids.map((id) => pos[id][1]);
      const x0 = Math.min(...xs); const y0 = Math.min(...ys);
      return { x: x0, y: y0, w: Math.max(...xs) - x0 + B, h: Math.max(...ys) - y0 + B };
    };
    const a = box(src.map((p) => p[0]));
    const b = box(src.map((p) => p[1]));
    // Height actually covered by matching block positions (the box adds one block size).
    const span = a.h - B;
    if (a.w < o.minExtent || a.h < o.minExtent) continue;
    if (o.lineHeight && span * scale < o.minLines * o.lineHeight) continue;
    const [sx, sy] = key.split(',').map((v) => Number(v) * 2);
    // Direct check: does (almost) every textured block in the region reappear at this shift?
    let inside = 0;
    let matched = 0;
    for (let i = 0; i < pos.length; i += 2) {
      const [px, py] = pos[i];
      if (px < a.x || py < a.y || px + B > a.x + a.w || py + B > a.y + a.h) continue;
      inside++;
      let ok = false;
      for (let oy = -1; oy <= 1 && !ok; oy++) {
        for (let ox = -1; ox <= 1 && !ok; ox++) {
          const qx = px + sx + ox;
          const qy = py + sy + oy;
          if (qx < 0 || qy < 0 || qx + B > w || qy + B > h) continue;
          const g = describe(data, w, qx, qy, B, o.quant);
          let d = 0;
          for (let k = 0; k < 16; k++) d = Math.max(d, Math.abs(g[k] - feats[i][k]));
          ok = d <= o.maxDiff;
        }
      }
      if (ok) matched++;
    }
    const density = inside ? matched / inside : 0;
    if (density < o.minDensity) continue;
    const ncc = verify(img, a, b);
    if (ncc < o.minCorrelation) continue;
    const toPage = (r) => ({ x: Math.round(r.x * scale), y: Math.round(r.y * scale), w: Math.round(r.w * scale), h: Math.round(r.h * scale) });
    regions.push({ source: toPage(a), copy: toPage(b), blocks: src.length, density: round(density, 3), correlation: round(ncc, 3), shift: { dx: Math.round(sx * scale), dy: Math.round(sy * scale) } });
  }
  regions.sort((p, q) => q.blocks - p.blocks);
  // Merge regions describing the same duplication (neighbouring shift bins).
  const merged = [];
  for (const r of regions) {
    if (merged.some((m) => overlap(m.source, r.source) > 0.5 && overlap(m.copy, r.copy) > 0.5)) continue;
    merged.push(r);
  }
  return { regions: merged.slice(0, 6), analysed: { width: w, height: h, scale: round(scale, 3) }, blocks: feats.length };
}

/** Best normalised cross-correlation of two equally sized regions, allowing ±1 px misalignment. */
export function verify(img, a, b) {
  const { width: w, height: h, data } = img;
  const rw = Math.min(a.w, b.w) - 2;
  const rh = Math.min(a.h, b.h) - 2;
  if (rw < 4 || rh < 4) return 0;
  let best = -1;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0; let n = 0;
      for (let y = 1; y < rh; y++) {
        const ya = a.y + y; const yb = b.y + y + oy;
        if (ya >= h || yb < 0 || yb >= h) continue;
        for (let x = 1; x < rw; x++) {
          const xa = a.x + x; const xb = b.x + x + ox;
          if (xa >= w || xb < 0 || xb >= w) continue;
          const va = data[ya * w + xa]; const vb = data[yb * w + xb];
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
        }
      }
      if (!n) continue;
      const cov = sab / n - (sa / n) * (sb / n);
      const den = Math.sqrt(Math.max(1e-9, (saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)));
      best = Math.max(best, cov / den);
    }
  }
  return best;
}

/** 16 quantised 3×3-cell means of the B×B block at (x, y) — the block descriptor. */
function describe(data, w, x, y, B, quant) {
  const cell = B / 4;
  const f = new Int16Array(16);
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      let cs = 0;
      for (let yy = 0; yy < cell; yy++) for (let xx = 0; xx < cell; xx++) cs += data[(y + cy * cell + yy) * w + x + cx * cell + xx];
      f[cy * 4 + cx] = Math.round(cs / (cell * cell) / quant);
    }
  }
  return f;
}

function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (x * y) / Math.min(a.w * a.h, b.w * b.h || 1);
}

/** Indices of the largest connected group of points (grid distance ≤ link). */
function largestCluster(points, link) {
  const n = points.length;
  const seen = new Uint8Array(n);
  const grid = new Map();
  points.forEach(([x, y], i) => {
    const k = `${Math.floor(x / link)},${Math.floor(y / link)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  let best = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const comp = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const gx = Math.floor(points[c][0] / link);
      const gy = Math.floor(points[c][1] / link);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
          if (seen[j]) continue;
          if (Math.abs(points[j][0] - points[c][0]) <= link && Math.abs(points[j][1] - points[c][1]) <= link) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}
