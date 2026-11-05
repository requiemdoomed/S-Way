/**
 * Image-processing primitives (the browser-side equivalent of the OpenCV operations
 * named in the specification). All functions operate on grayscale images of the form
 * { width, height, data: Uint8ClampedArray } (0 = black, 255 = white) or on binary
 * masks (Uint8Array, 1 = ink). Pure JavaScript: runs in Web Workers and Node tests.
 */

export function makeGray(width, height, data) {
  return { width, height, data: data || new Uint8ClampedArray(width * height) };
}

/** RGBA → luminance (ITU-R BT.601). */
export function rgbaToGray(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // Composite transparent pixels onto white paper.
    out[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a);
  }
  return makeGray(width, height, out);
}

/** Area-averaging downscale so the longest side is at most maxSide. Returns the input if already small. */
export function downscale(img, maxSide) {
  const { width: w, height: h } = img;
  const s = maxSide / Math.max(w, h);
  if (s >= 1) return img;
  const nw = Math.max(1, Math.round(w * s));
  const nh = Math.max(1, Math.round(h * s));
  const out = new Uint8ClampedArray(nw * nh);
  const fx = w / nw;
  const fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += img.data[yy * w + xx];
      out[y * nw + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return makeGray(nw, nh, out);
}

/** Bilinear resize to exact dimensions. */
export function resize(img, nw, nh) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, ((y + 0.5) * h) / nh - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const dy = Math.max(0, sy - y0);
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, ((x + 0.5) * w) / nw - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const dx = Math.max(0, sx - x0);
      const top = data[y0 * w + x0] * (1 - dx) + data[y0 * w + x1] * dx;
      const bot = data[y1 * w + x0] * (1 - dx) + data[y1 * w + x1] * dx;
      out[y * nw + x] = top * (1 - dy) + bot * dy;
    }
  }
  return makeGray(nw, nh, out);
}

export function crop(img, x, y, cw, ch) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + cw));
  const y1 = Math.min(img.height, Math.ceil(y + ch));
  const nw = Math.max(1, x1 - x0);
  const nh = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(nw * nh).fill(255);
  for (let yy = 0; yy < nh && y0 + yy < img.height; yy++) {
    out.set(img.data.subarray((y0 + yy) * img.width + x0, (y0 + yy) * img.width + x0 + nw), yy * nw);
  }
  return makeGray(nw, nh, out);
}

/** 3×3 box blur (denoising). */
export function boxBlur(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += data[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return makeGray(w, h, out);
}

/** Linear contrast stretch between the 1st and 99th percentiles. */
export function stretchContrast(img) {
  const hist = new Uint32Array(256);
  for (const v of img.data) hist[v]++;
  const n = img.data.length;
  let lo = 0;
  let hi = 255;
  for (let c = 0, i = 0; i < 256; i++) { c += hist[i]; if (c >= n * 0.01) { lo = i; break; } }
  for (let c = 0, i = 255; i >= 0; i--) { c += hist[i]; if (c >= n * 0.01) { hi = i; break; } }
  if (hi - lo < 10) return img;
  const out = new Uint8ClampedArray(n);
  const k = 255 / (hi - lo);
  for (let i = 0; i < n; i++) out[i] = (img.data[i] - lo) * k;
  return makeGray(img.width, img.height, out);
}

/** Otsu's global threshold. */
export function otsu(img) {
  const hist = new Float64Array(256);
  for (const v of img.data) hist[v]++;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Sauvola adaptive binarisation using integral images (robust to uneven lighting
 * in photographed pages). Returns a mask with 1 = ink.
 */
export function binarize(img, { window = 0, k = 0.2, globalGuard = true } = {}) {
  const { width: w, height: h, data } = img;
  const win = window || Math.max(15, Math.round(Math.min(w, h) / 40) | 1);
  const r = win >> 1;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  const gt = globalGuard ? otsu(img) : 255;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      const q = sq[y1 * W + x1] - sq[y0 * W + x1] - sq[y1 * W + x0] + sq[y0 * W + x0];
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, q / n - m * m));
      const t = m * (1 + k * (sd / 128 - 1));
      const v = data[y * w + x];
      // The global guard suppresses paper texture that local thresholds pick up in blank areas.
      mask[y * w + x] = v < t && v < gt + 25 ? 1 : 0;
    }
  }
  return mask;
}

/** Remove isolated specks smaller than minArea pixels. */
export function despeckle(mask, w, h, minArea = 4) {
  const { labels, comps } = connectedComponents(mask, w, h);
  const keep = new Uint8Array(comps.length + 1);
  comps.forEach((c, i) => { keep[i + 1] = c.area >= minArea ? 1 : 0; });
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = labels[i] ? keep[labels[i]] : 0;
  return out;
}

/** 8-connected component labelling (two-pass union–find) with per-component statistics. */
export function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const nb = [];
      if (x > 0 && labels[i - 1]) nb.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) nb.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) nb.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) nb.push(labels[i - w + 1]);
      }
      if (!nb.length) { parent.push(next); labels[i] = next++; continue; }
      let m = find(nb[0]);
      for (const l of nb) m = Math.min(m, find(l));
      labels[i] = m;
      for (const l of nb) { const r = find(l); if (r !== m) parent[r] = m; }
    }
  }
  const remap = new Int32Array(next);
  const comps = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let id = remap[root];
    if (!id) {
      comps.push({ x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, sx: 0, sy: 0 });
      id = remap[root] = comps.length;
    }
    labels[i] = id;
    const c = comps[id - 1];
    const x = i % w;
    const y = (i - x) / w;
    if (x < c.x0) c.x0 = x;
    if (x > c.x1) c.x1 = x;
    if (y < c.y0) c.y0 = y;
    if (y > c.y1) c.y1 = y;
    c.area++;
    c.sx += x;
    c.sy += y;
  }
  for (const c of comps) { c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; c.cx = c.sx / c.area; c.cy = c.sy / c.area; }
  return { labels, comps };
}

export function inkBounds(mask, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return count ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count } : null;
}

export function rowProfile(mask, w, h, x0 = 0, x1 = w) {
  const p = new Float64Array(h);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += mask[y * w + x]; p[y] = s; }
  return p;
}

export function colProfile(mask, w, y0, y1) {
  const p = new Float64Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) p[x] += mask[y * w + x];
  return p;
}

export function smooth1d(arr, radius) {
  const out = new Float64Array(arr.length);
  let s = 0;
  let n = 0;
  for (let i = 0; i < Math.min(radius, arr.length); i++) { s += arr[i]; n++; }
  for (let i = 0; i < arr.length; i++) {
    if (i + radius < arr.length) { s += arr[i + radius]; n++; }
    if (i - radius - 1 >= 0) { s -= arr[i - radius - 1]; n--; }
    out[i] = s / n;
  }
  return out;
}

/** Sample ink pixel coordinates (bounded for speed). */
export function inkPoints(mask, w, h, max = 30000) {
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i];
  const step = Math.max(1, Math.floor(total / max));
  const pts = [];
  let c = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && c++ % step === 0) pts.push([i % w, Math.floor(i / w)]);
  }
  return pts;
}

/**
 * Skew estimate: the rotation that makes the horizontal projection of ink most
 * "peaky" (text lines become sharp). Searches ±maxDeg.
 */
export function estimateSkew(mask, w, h, maxDeg = 6, step = 0.25) {
  const pts = inkPoints(mask, w, h, 20000);
  if (pts.length < 200) return 0;
  let best = 0;
  let bestScore = -Infinity;
  let zeroScore = Infinity;
  const bins = new Float64Array(h * 2 + 10);
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += step) {
    const t = (d * Math.PI) / 180;
    const sn = Math.sin(t);
    const cs = Math.cos(t);
    bins.fill(0);
    for (const [x, y] of pts) {
      const yy = Math.round(-x * sn + y * cs + h * 0.5);
      if (yy >= 0 && yy < bins.length) bins[yy]++;
    }
    // Projection-profile energy: text lines aligned with the rows maximise the sum of squares.
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    if (Math.abs(d) < 1e-9) zeroScore = score;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  // Require a clear improvement over no rotation; otherwise leave the page as it is.
  if (bestScore < zeroScore * 1.03) return 0;
  return Math.round(best * 100) / 100;
}

/** Rotate a grayscale image about its centre (bilinear, white fill). */
export function rotate(img, deg) {
  if (!deg) return img;
  const { width: w, height: h, data } = img;
  const t = (-deg * Math.PI) / 180;
  const cs = Math.cos(t);
  const sn = Math.sin(t);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = cs * (x - cx) - sn * (y - cy) + cx;
      const sy = sn * (x - cx) + cs * (y - cy) + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const dx = sx - x0;
      const dy = sy - y0;
      const i = y0 * w + x0;
      out[y * w + x] = (data[i] * (1 - dx) + data[i + 1] * dx) * (1 - dy) + (data[i + w] * (1 - dx) + data[i + w + 1] * dx) * dy;
    }
  }
  return makeGray(w, h, out);
}

/** Image-quality measures: contrast, sharpness (variance of the Laplacian) and brightness. */
export function quality(img) {
  const { width: w, height: h, data } = img;
  let s = 0;
  let q = 0;
  for (const v of data) { s += v; q += v * v; }
  const n = data.length;
  const meanV = s / n;
  const contrast = Math.sqrt(Math.max(0, q / n - meanV * meanV));
  let ls = 0;
  let lq = 0;
  let ln = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const l = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      ls += l;
      lq += l * l;
      ln++;
    }
  }
  const lm = ls / (ln || 1);
  const sharpness = lq / (ln || 1) - lm * lm;
  const issues = [];
  if (contrast < 25) issues.push('Low contrast');
  if (sharpness < 60) issues.push('Blurry or low detail');
  if (meanV < 90) issues.push('Very dark image');
  if (Math.max(w, h) < 600) issues.push('Low resolution');
  return { brightness: round(meanV), contrast: round(contrast), sharpness: round(sharpness), width: w, height: h, issues };
}

/** Sobel gradient-orientation histogram of edge pixels (shape / stroke-direction descriptor). */
export function orientationHistogram(img, mask, bins = 12) {
  const { width: w, height: h, data } = img;
  const hist = new Float64Array(bins);
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && !(mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w])) continue;
      const gx = -data[i - w - 1] - 2 * data[i - 1] - data[i + w - 1] + data[i - w + 1] + 2 * data[i + 1] + data[i + w + 1];
      const gy = -data[i - w - 1] - 2 * data[i - w] - data[i - w + 1] + data[i + w - 1] + 2 * data[i + w] + data[i + w + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < 80) continue;
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI; // orientation, not direction
      hist[Math.min(bins - 1, Math.floor((a / Math.PI) * bins))] += mag;
      total += mag;
    }
  }
  return Array.from(hist, (v) => (total ? v / total : 0));
}

/** Uniform local binary pattern histogram (10 bins) — local texture of the ink. */
export function lbpHistogram(img, mask) {
  const { width: w, height: h, data } = img;
  const hist = new Float64Array(10);
  const off = [-w - 1, -w, -w + 1, 1, w + 1, w, w - 1, -1];
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      const c = data[i];
      let code = 0;
      for (let k = 0; k < 8; k++) code |= (data[i + off[k]] >= c ? 1 : 0) << k;
      let transitions = 0;
      let ones = 0;
      for (let k = 0; k < 8; k++) {
        const b = (code >> k) & 1;
        ones += b;
        if (b !== ((code >> ((k + 1) % 8)) & 1)) transitions++;
      }
      hist[transitions <= 2 ? ones : 9]++;
      total++;
    }
  }
  return Array.from(hist, (v) => (total ? v / total : 0));
}

/** Chi-square similarity of two histograms in [0,1] (1 = identical). */
export function histSimilarity(p, q) {
  let chi = 0;
  for (let i = 0; i < p.length; i++) { const s = p[i] + q[i]; if (s > 0) chi += ((p[i] - q[i]) ** 2) / s; }
  return 1 - chi / 2;
}

/** Mean SSIM over 8×8 windows (step 4) for equally sized grayscale images. */
export function ssim(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('SSIM requires equal sizes');
  const { width: w, height: h } = a;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let n = 0;
  const map = [];
  for (let y = 0; y + 8 <= h; y += 4) {
    const row = [];
    for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0; let mb = 0;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) { const i = (y + yy) * w + x + xx; ma += a.data[i]; mb += b.data[i]; }
      ma /= 64; mb /= 64;
      let va = 0; let vb = 0; let cov = 0;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
        const i = (y + yy) * w + x + xx;
        const da = a.data[i] - ma;
        const db = b.data[i] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= 63; vb /= 63; cov /= 63;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      row.push(s);
      total += s;
      n++;
    }
    map.push(row);
  }
  return { mean: n ? total / n : 0, map };
}

/** Chamfer (3-4) distance transform: distance of every pixel to the nearest ink pixel. */
export function distanceTransform(mask, w, h) {
  const INF = 1e9;
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - w] + 3);
        if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4);
        if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + 4);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
      if (y < h - 1) {
        d[i] = Math.min(d[i], d[i + w] + 3);
        if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + 4);
        if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4);
      }
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Hu's seven invariant moments of a binary shape (log-scaled). */
export function huMoments(mask, w, h) {
  let m00 = 0; let m10 = 0; let m01 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { m00++; m10 += x; m01 += y; }
  if (!m00) return new Array(7).fill(0);
  const xc = m10 / m00;
  const yc = m01 / m00;
  const mu = (p, q) => {
    let s = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) s += (x - xc) ** p * (y - yc) ** q;
    return s;
  };
  const eta = (p, q) => mu(p, q) / m00 ** (1 + (p + q) / 2);
  const n20 = eta(2, 0); const n02 = eta(0, 2); const n11 = eta(1, 1);
  const n30 = eta(3, 0); const n03 = eta(0, 3); const n21 = eta(2, 1); const n12 = eta(1, 2);
  const hu = [
    n20 + n02,
    (n20 - n02) ** 2 + 4 * n11 ** 2,
    (n30 - 3 * n12) ** 2 + (3 * n21 - n03) ** 2,
    (n30 + n12) ** 2 + (n21 + n03) ** 2,
    (n30 - 3 * n12) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2) + (3 * n21 - n03) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2),
    (n20 - n02) * ((n30 + n12) ** 2 - (n21 + n03) ** 2) + 4 * n11 * (n30 + n12) * (n21 + n03),
    (3 * n21 - n03) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2) - (n30 - 3 * n12) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2),
  ];
  return hu.map((v) => (v === 0 ? 0 : -Math.sign(v) * Math.log10(Math.abs(v))));
}

export function round(x, d = 3) {
  return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;
}

// ------------------------------------------------------------------ geometry (perspective correction)
/**
 * Homography H mapping the 4 points `from` onto `to` (each [[x,y]×4]), solved with
 * Gaussian elimination. Returns a 3×3 matrix as a flat array of 9 (h33 = 1), or null.
 */
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Warp `img` into an outW×outH image; Hinv maps OUTPUT pixels to SOURCE pixels (bilinear, white fill). */
export function warpPerspective(img, Hinv, outW, outH) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(outW * outH).fill(255);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = applyH(Hinv, x + 0.5, y + 0.5);
      const fx = sx - 0.5;
      const fy = sy - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const dx = fx - x0;
      const dy = fy - y0;
      const i = y0 * w + x0;
      out[y * outW + x] = (data[i] * (1 - dx) + data[i + 1] * dx) * (1 - dy) + (data[i + w] * (1 - dx) + data[i + w + 1] * dx) * dy;
    }
  }
  return makeGray(outW, outH, out);
}

/**
 * Find the four corners of a bright sheet of paper on a darker background.
 * Returns {corners:[tl,tr,br,bl], areaShare, skewed} in image coordinates, or null.
 */
export function findPaperQuad(img) {
  const small = downscale(img, 500);
  const s = img.width / small.width;
  const { width: w, height: h, data } = small;
  const t = otsu(small);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < bright.length; i++) bright[i] = data[i] > t ? 1 : 0;
  // Close small holes (text) by a 2-pixel dilation of the paper mask.
  const closed = new Uint8Array(bright);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (bright[y * w + x]) continue;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) n += bright[(y + dy) * w + x + dx];
    if (n >= 13) closed[y * w + x] = 1;
  }
  const { labels, comps } = connectedComponents(closed, w, h);
  if (!comps.length) return null;
  let bi = 0;
  comps.forEach((c, i) => { if (c.area > comps[bi].area) bi = i; });
  const big = comps[bi];
  const areaShare = big.area / (w * h);
  if (areaShare < 0.2 || areaShare > 0.97) return null; // no distinct sheet, or the sheet fills the frame
  const id = bi + 1;
  let tl = null; let tr = null; let br = null; let bl = null;
  let mTl = Infinity; let mBr = -Infinity; let mTr = -Infinity; let mBl = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (labels[y * w + x] !== id) continue;
    const sp = x + y; const df = x - y;
    if (sp < mTl) { mTl = sp; tl = [x, y]; }
    if (sp > mBr) { mBr = sp; br = [x, y]; }
    if (df > mTr) { mTr = df; tr = [x, y]; }
    if (df < mBl) { mBl = df; bl = [x, y]; }
  }
  // The background must be clearly darker than the sheet.
  let inS = 0; let inN = 0; let outS = 0; let outN = 0;
  for (let i = 0; i < labels.length; i += 3) { if (labels[i] === id) { inS += data[i]; inN++; } else { outS += data[i]; outN++; } }
  if (!outN || inS / inN - outS / outN < 40) return null;
  const corners = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) * s, (y + 0.5) * s]);
  const quadArea = Math.abs(corners.reduce((a, [x, y], i) => { const [x2, y2] = corners[(i + 1) % 4]; return a + x * y2 - x2 * y; }, 0)) / 2;
  if (quadArea < img.width * img.height * 0.18) return null;
  const off = Math.max(Math.abs(corners[0][1] - corners[1][1]), Math.abs(corners[3][1] - corners[2][1]), Math.abs(corners[0][0] - corners[3][0]), Math.abs(corners[1][0] - corners[2][0]));
  return { corners, areaShare: round(areaShare, 3), skewed: off > Math.min(img.width, img.height) * 0.015 };
}

/** Rectify a photographed sheet: warp its quadrilateral to an upright rectangle. */
export function rectifyPaper(img, quad, maxSide = 1800) {
  const [tl, tr, br, bl] = quad.corners;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(d(tl, tr), d(bl, br));
  let H = Math.max(d(tl, bl), d(tr, br));
  const k = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(8, Math.round(W * k));
  H = Math.max(8, Math.round(H * k));
  const Hinv = homography([[0, 0], [W, 0], [W, H], [0, H]], [tl, tr, br, bl]);
  if (!Hinv) return null;
  return warpPerspective(img, Hinv, W, H);
}

// ------------------------------------------------------------------ writer-identification texture features
/** Contour (boundary) pixels of a binary mask: ink pixels with at least one 4-neighbour of paper. */
export function contourMask(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) out[i] = 1;
  }
  return out;
}

/**
 * Edge-hinge distribution (after Bulacu & Schomaker, 2007): joint distribution of the
 * directions of the two contour "legs" leaving each contour pixel, measured on a
 * square ring of radius r. Captures curvature and slant habits of a writer.
 * 12 directions → 66 unordered direction pairs. Returns a normalised histogram.
 */
export function edgeHinge(mask, w, h, r = 4, dirs = 12) {
  const contour = contourMask(mask, w, h);
  const ring = [];
  for (let k = -r; k < r; k++) ring.push([k, -r]);
  for (let k = -r; k < r; k++) ring.push([r, k]);
  for (let k = r; k > -r; k--) ring.push([k, r]);
  for (let k = r; k > -r; k--) ring.push([-r, k]);
  const pairIndex = [];
  let n = 0;
  for (let i = 0; i < dirs; i++) { pairIndex.push([]); for (let j = 0; j < dirs; j++) pairIndex[i].push(j > i ? n++ : -1); }
  const hist = new Float64Array(n);
  let total = 0;
  for (let y = r; y < h - r; y += 2) {
    for (let x = r; x < w - r; x += 2) {
      if (!contour[y * w + x]) continue;
      const hits = [];
      let prev = 0;
      for (let k = 0; k < ring.length; k++) {
        const v = contour[(y + ring[k][1]) * w + x + ring[k][0]];
        if (v && !prev) hits.push(k);
        prev = v;
      }
      if (hits.length !== 2) continue;
      const bin = (k) => {
        let a = Math.atan2(-ring[k][1], ring[k][0]);
        if (a < 0) a += 2 * Math.PI;
        return Math.min(dirs - 1, Math.floor((a / (2 * Math.PI)) * dirs));
      };
      const b1 = bin(hits[0]);
      const b2 = bin(hits[1]);
      if (b1 === b2) continue;
      hist[pairIndex[Math.min(b1, b2)][Math.max(b1, b2)]]++;
      total++;
    }
  }
  return Array.from(hist, (v) => (total ? v / total : 0));
}

/** Histogram of horizontal background run lengths inside text lines, normalised by line height (16 bins). */
export function whiteRunHistogram(mask, w, lines, bins = 16) {
  const hist = new Float64Array(bins);
  let total = 0;
  for (const l of lines) {
    const H = Math.max(1, l.y1 - l.y0 + 1);
    for (let y = l.y0; y <= l.y1; y += 2) {
      let run = 0;
      let seenInk = false;
      for (let x = l.x0; x <= l.x1; x++) {
        if (mask[y * w + x]) {
          if (seenInk && run) { hist[Math.min(bins - 1, Math.floor((run / H) * 8))]++; total++; }
          seenInk = true;
          run = 0;
        } else run++;
      }
    }
  }
  return Array.from(hist, (v) => (total ? v / total : 0));
}
