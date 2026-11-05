/**
 * MODULE 1 — Document Preprocessing Engine.
 *
 * Works on a *copy* of each page (the original pixels are never modified) and
 * records every operation applied, so the report can show exactly what was done.
 *
 * Steps: resolution inspection → resize → page-boundary detection → denoise →
 * contrast enhancement → orientation check → deskew → adaptive thresholding →
 * despeckle → page segmentation (text block and text lines).
 */
import {
  downscale, boxBlur, stretchContrast, binarize, despeckle, estimateSkew, rotate, quality, otsu,
  rowProfile, smooth1d, inkBounds, crop, makeGray, round, findPaperQuad, rectifyPaper,
} from './imaging.js';

/** Detect the paper inside a darker background (photographed pages). */
function detectPageBoundary(img) {
  const { width: w, height: h, data } = img;
  const t = otsu(img);
  // Only meaningful if the border is clearly darker than the centre.
  const sample = (x0, y0, x1, y1) => { let s = 0; let n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += data[y * w + x]; n++; } return s / (n || 1); };
  const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const border = (sample(0, 0, w, bw) + sample(0, h - bw, w, h) + sample(0, 0, bw, h) + sample(w - bw, 0, w, h)) / 4;
  const centre = sample(Math.round(w * 0.3), Math.round(h * 0.3), Math.round(w * 0.7), Math.round(h * 0.7));
  if (centre - border < 40) return null;
  const rows = [];
  const cols = [];
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x += 2) if (data[y * w + x] > t) c++; rows.push(c / (w / 2)); }
  for (let x = 0; x < w; x++) { let c = 0; for (let y = 0; y < h; y += 2) if (data[y * w + x] > t) c++; cols.push(c / (h / 2)); }
  const first = (arr) => arr.findIndex((v) => v > 0.5);
  const last = (arr) => arr.length - 1 - [...arr].reverse().findIndex((v) => v > 0.5);
  const box = { x: first(cols), y: first(rows), x1: last(cols), y1: last(rows) };
  if (box.x < 0 || box.y < 0 || box.x1 - box.x < w * 0.4 || box.y1 - box.y < h * 0.4) return null;
  return { x: box.x, y: box.y, w: box.x1 - box.x + 1, h: box.y1 - box.y + 1 };
}

/** Horizontal text-line bands from the smoothed row profile of a mask. */
export function detectLines(mask, w, h) {
  const b = inkBounds(mask, w, h);
  if (!b) return [];
  const prof = smooth1d(rowProfile(mask, w, h, b.x0, b.x1 + 1), 2);
  let max = 0;
  for (const v of prof) if (v > max) max = v;
  const thr = Math.max(1, max * 0.08);
  const lines = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && prof[y] > thr;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { lines.push({ y0: start, y1: y - 1 }); start = -1; }
  }
  // Merge fragments closer than a third of the median line height (accents, dots, descenders).
  const heights = lines.map((l) => l.y1 - l.y0 + 1).sort((a, c) => a - c);
  const medH = heights[heights.length >> 1] || 1;
  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && l.y0 - prev.y1 < medH * 0.33) prev.y1 = l.y1;
    else merged.push({ ...l });
  }
  return merged.filter((l) => l.y1 - l.y0 + 1 >= Math.max(4, medH * 0.35)).map((l) => {
    let x0 = w; let x1 = -1; let ink = 0;
    for (let y = l.y0; y <= l.y1; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return { ...l, x0, x1, height: l.y1 - l.y0 + 1, ink };
  });
}

/** Orientation check: text lines should give a much more "peaky" row profile than column profile. */
function orientationCheck(mask, w, h) {
  const variation = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += (p[i] - p[i - 1]) ** 2; let m = 0; for (const v of p) m += v * v; return m ? s / m : 0; };
  const rows = smooth1d(rowProfile(mask, w, h), 1);
  const cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cols[x] += mask[y * w + x];
  const r = variation(rows);
  const c = variation(smooth1d(cols, 1));
  if (!r && !c) return { orientation: 'unknown', confidence: 0 };
  const ratio = r / (c || 1e-9);
  if (ratio > 1.3) return { orientation: 'upright (horizontal text lines)', rotatedQuarter: false, ratio: round(ratio) };
  if (ratio < 0.75) return { orientation: 'possibly rotated 90° (vertical text lines)', rotatedQuarter: true, ratio: round(ratio) };
  return { orientation: 'undetermined (no dominant line direction)', rotatedQuarter: false, ratio: round(ratio) };
}

/**
 * Preprocess one page image.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} original grayscale page
 * @param {{maxSide?: number, deskew?: boolean}} opts
 */
export function preprocessPage(original, { maxSide = 1800, deskew = true } = {}) {
  const operations = [];
  const resolution = { width: original.width, height: original.height, megapixels: round((original.width * original.height) / 1e6, 2) };
  operations.push(`Inspected resolution: ${original.width} × ${original.height} px`);

  // Working copy — the original buffer is never written to.
  let img = makeGray(original.width, original.height, new Uint8ClampedArray(original.data));
  if (Math.max(img.width, img.height) > maxSide) {
    img = downscale(img, maxSide);
    operations.push(`Resized working copy to ${img.width} × ${img.height} px`);
  }
  const before = quality(img);

  // Photographed pages: find the sheet's four corners and undo the camera perspective.
  let boundary = null;
  const quad = findPaperQuad(img);
  if (quad) {
    if (quad.skewed) {
      const warped = rectifyPaper(img, quad, maxSide);
      if (warped) {
        img = warped;
        boundary = { kind: 'perspective', corners: quad.corners.map(([x, y]) => [round(x, 1), round(y, 1)]) };
        operations.push('Detected the sheet’s four corners and corrected the camera perspective (homography warp)');
      }
    } else {
      const xs = quad.corners.map((c) => c[0]);
      const ys = quad.corners.map((c) => c[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      img = crop(img, box.x, box.y, box.w, box.h);
      boundary = { kind: 'crop', ...box };
      operations.push('Detected the page boundary against a darker background and cropped to it');
    }
  } else {
    const box = detectPageBoundary(img);
    if (box) {
      img = crop(img, box.x, box.y, box.w, box.h);
      boundary = { kind: 'crop', ...box };
      operations.push('Detected the page boundary against a darker background and cropped to it');
    }
  }

  img = boxBlur(img);
  operations.push('Denoised with a 3 × 3 smoothing filter');
  const stretched = stretchContrast(img);
  if (stretched !== img) operations.push('Enhanced contrast (1st–99th percentile stretch)');
  img = stretched;
  operations.push('Converted to grayscale');

  let mask = binarize(img);
  operations.push('Applied adaptive (Sauvola) thresholding');
  const orient = orientationCheck(mask, img.width, img.height);
  operations.push(`Orientation check: ${orient.orientation}`);

  let skewDeg = 0;
  if (deskew) {
    skewDeg = estimateSkew(mask, img.width, img.height);
    if (Math.abs(skewDeg) >= 0.3) {
      img = rotate(img, -skewDeg);
      mask = binarize(img);
      operations.push(`Deskewed by ${(-skewDeg).toFixed(2)}°`);
    } else {
      operations.push('Skew below 0.3° — no rotation applied');
    }
  }
  mask = despeckle(mask, img.width, img.height, 4);
  operations.push('Removed isolated specks (< 4 px)');

  const lines = detectLines(mask, img.width, img.height);
  const block = inkBounds(mask, img.width, img.height);
  operations.push(`Segmented page: ${lines.length} text line${lines.length === 1 ? '' : 's'} detected`);

  return {
    image: img,
    mask,
    width: img.width,
    height: img.height,
    lines,
    textBlock: block,
    skewDeg,
    orientation: orient,
    boundary,
    resolution,
    quality: before,
    operations,
  };
}
