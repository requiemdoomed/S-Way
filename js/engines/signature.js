/**
 * MODULE 6 — Signature Visual Comparison (offline / static images only).
 *
 * Compares the *visual appearance* of two signature crops after normalisation and
 * alignment. Static images cannot reveal pen pressure, speed or stroke order
 * (that requires online/dynamic capture), so S-Way never declares a signature
 * authentic or forged. Skilled imitations can look visually very similar, and a
 * genuine signer's signatures naturally vary.
 */
import {
  makeGray, otsu, despeckle, inkBounds, crop, resize, boxBlur, ssim, distanceTransform, huMoments,
  orientationHistogram, histSimilarity, connectedComponents, round,
} from './imaging.js';
import { cosineVec } from './text-utils.js';

export const SIG_W = 384;
export const SIG_H = 160;

/** Binarise a (usually clean) signature crop with Otsu and remove specks. */
function sigMask(img) {
  const t = otsu(img);
  const m = new Uint8Array(img.data.length);
  for (let i = 0; i < m.length; i++) m[i] = img.data[i] <= Math.min(t, 200) ? 1 : 0; // Otsu: class 0 is ≤ t
  return despeckle(m, img.width, img.height, 6);
}

/**
 * Normalise a signature crop: tight ink bounding box, scaled to fit SIG_W×SIG_H
 * preserving aspect ratio, centred on white.
 */
export function normalizeSignature(img) {
  const warnings = [];
  if (Math.max(img.width, img.height) < 120) warnings.push('The signature crop is very small; details may be lost.');
  const mask = sigMask(img);
  const b = inkBounds(mask, img.width, img.height);
  if (!b || b.count < 50) return { ok: false, warnings: [...warnings, 'No signature strokes were found in the selected region.'] };
  const pad = 2;
  const tight = crop(img, b.x0 - pad, b.y0 - pad, b.w + 2 * pad, b.h + 2 * pad);
  const scale = Math.min((SIG_W - 16) / tight.width, (SIG_H - 16) / tight.height);
  const nw = Math.max(1, Math.round(tight.width * scale));
  const nh = Math.max(1, Math.round(tight.height * scale));
  const scaled = resize(tight, nw, nh);
  // Pad with the crop's own paper tone so the normalised image has no visible border.
  const t = otsu(tight);
  let paperSum = 0;
  let paperN = 0;
  for (const v of tight.data) if (v > t) { paperSum += v; paperN++; }
  const paper = paperN ? Math.round(paperSum / paperN) : 255;
  const canvas = makeGray(SIG_W, SIG_H, new Uint8ClampedArray(SIG_W * SIG_H).fill(paper));
  const ox = Math.floor((SIG_W - nw) / 2);
  const oy = Math.floor((SIG_H - nh) / 2);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) canvas.data[(oy + y) * SIG_W + ox + x] = scaled.data[y * nw + x];
  const nmask = sigMask(canvas);
  let ink = 0;
  for (const v of nmask) ink += v;
  const { comps } = connectedComponents(nmask, SIG_W, SIG_H);
  return {
    ok: true,
    warnings,
    image: canvas,
    mask: nmask,
    aspectRatio: round(b.w / b.h, 3),
    inkDensity: round(ink / (nw * nh), 4),
    strokes: comps.filter((c) => c.area > 15).length,
    originalSize: { width: b.w, height: b.h },
    scale: round(scale, 3),
  };
}

/** Transform a mask by rotation (deg) and translation (dx, dy) — nearest neighbour. */
function transformMask(mask, w, h, deg, dx, dy) {
  const t = (deg * Math.PI) / 180;
  const cs = Math.cos(t);
  const sn = Math.sin(t);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.round(cs * (x - dx - cx) + sn * (y - dy - cy) + cx);
      const sy = Math.round(-sn * (x - dx - cx) + cs * (y - dy - cy) + cy);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = mask[sy * w + sx];
    }
  }
  return out;
}

function dilate(mask, w, h, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy; const xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) out[yy * w + xx] = 1;
    }
  }
  return out;
}

function iou(a, b) {
  let inter = 0; let uni = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++; }
  return uni ? inter / uni : 0;
}

/** Search a small grid of rotations/shifts that best aligns B onto A (on dilated masks). */
export function alignMasks(ma, mb, w = SIG_W, h = SIG_H) {
  const da = dilate(ma, w, h, 2);
  const db = dilate(mb, w, h, 2);
  let best = { deg: 0, dx: 0, dy: 0, score: -1 };
  for (const deg of [-6, -3, 0, 3, 6]) {
    for (let dy = -8; dy <= 8; dy += 4) {
      for (let dx = -12; dx <= 12; dx += 4) {
        const s = iou(da, transformMask(db, w, h, deg, dx, dy));
        if (s > best.score) best = { deg, dx, dy, score: s };
      }
    }
  }
  return best;
}

function transformImage(img, deg, dx, dy) {
  const { width: w, height: h, data } = img;
  const t = (deg * Math.PI) / 180;
  const cs = Math.cos(t); const sn = Math.sin(t);
  const out = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.round(cs * (x - dx - w / 2) + sn * (y - dy - h / 2) + w / 2);
    const sy = Math.round(-sn * (x - dx - w / 2) + cs * (y - dy - h / 2) + h / 2);
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = data[sy * w + sx];
  }
  return makeGray(w, h, out);
}

function profileCorrelation(ma, mb, w, h, horizontal) {
  const pa = new Array(horizontal ? h : w).fill(0);
  const pb = new Array(horizontal ? h : w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = horizontal ? y : x;
    pa[k] += ma[y * w + x];
    pb[k] += mb[y * w + x];
  }
  return cosineVec(pa, pb);
}

/** Find substantial regions present in one signature but not the other. */
function regionDifferences(onlyMask, w, h, label) {
  const { comps } = connectedComponents(onlyMask, w, h);
  return comps
    .filter((c) => c.area > 60)
    .sort((a, b) => b.area - a.area)
    .slice(0, 5)
    .map((c) => ({ where: label, x: c.x0, y: c.y0, w: c.w, h: c.h, area: c.area, position: describePosition(c.cx / w, c.cy / h) }));
}

function describePosition(fx, fy) {
  const hz = fx < 0.33 ? 'left' : fx > 0.66 ? 'right' : 'centre';
  const vt = fy < 0.33 ? 'upper' : fy > 0.66 ? 'lower' : 'middle';
  return `${vt} ${hz}`;
}

/** Compare two normalised signatures. */
export function compareSignatures(na, nb) {
  const w = SIG_W;
  const h = SIG_H;
  const align = alignMasks(na.mask, nb.mask, w, h);
  const mbAligned = transformMask(nb.mask, w, h, align.deg, align.dx, align.dy);
  const imgB = transformImage(nb.image, align.deg, align.dx, align.dy);

  const s = ssim(boxBlur(boxBlur(na.image)), boxBlur(boxBlur(imgB)));
  const dtA = distanceTransform(na.mask, w, h);
  const dtB = distanceTransform(mbAligned, w, h);
  let dAB = 0; let nA = 0; let dBA = 0; let nB = 0;
  for (let i = 0; i < na.mask.length; i++) {
    if (na.mask[i]) { dAB += dtB[i]; nA++; }
    if (mbAligned[i]) { dBA += dtA[i]; nB++; }
  }
  const chamfer = ((dAB / (nA || 1)) + (dBA / (nB || 1))) / 2;

  const huA = huMoments(na.mask, w, h);
  const huB = huMoments(mbAligned, w, h);
  const huDistance = huA.slice(0, 4).reduce((acc, v, i) => acc + Math.abs(v - huB[i]), 0) / 4;

  const tolA = dilate(na.mask, w, h, 3);
  const tolB = dilate(mbAligned, w, h, 3);
  const diff = new Uint8Array(w * h); // 0 none, 1 A only, 2 B only, 3 both
  const onlyA = new Uint8Array(w * h);
  const onlyB = new Uint8Array(w * h);
  let both = 0; let aOnly = 0; let bOnly = 0;
  for (let i = 0; i < diff.length; i++) {
    const a = na.mask[i]; const b = mbAligned[i];
    if (a && b) { diff[i] = 3; both++; }
    else if (a) { diff[i] = 1; if (!tolB[i]) { onlyA[i] = 1; aOnly++; } }
    else if (b) { diff[i] = 2; if (!tolA[i]) { onlyB[i] = 1; bOnly++; } }
  }
  const inkA = na.mask.reduce((x, v) => x + v, 0) || 1;
  const inkB = mbAligned.reduce((x, v) => x + v, 0) || 1;

  const metrics = {
    ssim: round(s.mean, 4),
    tolerantOverlap: round(align.score, 4),
    chamferDistancePx: round(chamfer, 2),
    shapeMomentDistance: round(huDistance, 4),
    horizontalProfileCorrelation: round(profileCorrelation(na.mask, mbAligned, w, h, true), 4),
    verticalProfileCorrelation: round(profileCorrelation(na.mask, mbAligned, w, h, false), 4),
    strokeDirectionSimilarity: round(histSimilarity(orientationHistogram(na.image, na.mask, 12), orientationHistogram(imgB, mbAligned, 12)), 4),
    aspectRatioA: na.aspectRatio,
    aspectRatioB: nb.aspectRatio,
    aspectRatioDifference: round(Math.abs(Math.log(na.aspectRatio / nb.aspectRatio)), 4),
    strokeCountA: na.strokes,
    strokeCountB: nb.strokes,
    inkOnlyInA: round(aOnly / inkA, 4),
    inkOnlyInB: round(bOnly / inkB, 4),
  };

  return {
    alignment: { rotationDeg: align.deg, shiftX: align.dx, shiftY: align.dy },
    metrics,
    diffMap: diff,
    width: w,
    height: h,
    missingOrExtra: [...regionDifferences(onlyA, w, h, 'Only in first signature'), ...regionDifferences(onlyB, w, h, 'Only in second signature')],
    warnings: [...na.warnings, ...nb.warnings],
  };
}

/**
 * Suggest a signature region on a preprocessed page (must be confirmed by the user).
 * If the page is essentially a single signature, the whole ink area is returned.
 */
export function suggestSignatureRegion(pre) {
  const { lines, width, height, textBlock } = pre;
  if (!textBlock) return null;
  const pad = (r) => ({ x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), w: Math.min(width, r.w + 20), h: Math.min(height, r.h + 20) });
  if (lines.length <= 3) return { ...pad({ x: textBlock.x0, y: textBlock.y0, w: textBlock.w, h: textBlock.h }), basis: 'whole ink area (page holds little text)' };
  const lower = lines.filter((l) => l.y0 > height * 0.55);
  const medH = lines.map((l) => l.height).sort((a, b) => a - b)[lines.length >> 1];
  const cand = [...lower].reverse().find((l) => l.height > medH * 1.25 && (l.x1 - l.x0) < width * 0.6);
  if (!cand) return null;
  return { ...pad({ x: cand.x0, y: cand.y0, w: cand.x1 - cand.x0 + 1, h: cand.height }), basis: 'tall, short line in the lower part of the page' };
}
