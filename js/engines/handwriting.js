/**
 * MODULE 5 — Handwriting Feature Analysis (experimental).
 *
 * Measures handwriting characteristics on a preprocessed page and compares two
 * pages feature by feature. This is a HANDWRITING-FEATURE COMPARISON, not writer
 * identification: pens, paper, scanning, writing speed, deliberate disguise and
 * shared schooling all change these measurements, and different writers can share
 * them. No neural writer-verification model is shipped (see LIMITATIONS.md).
 *
 * All length measurements are normalised by the median text-line height so that
 * pages scanned at different resolutions remain comparable.
 */
import {
  connectedComponents, colProfile, orientationHistogram, lbpHistogram, histSimilarity, inkPoints, round,
  edgeHinge, whiteRunHistogram,
} from './imaging.js';
import { median, mean, std } from './text-utils.js';

/** Default within-writer variability scales (overridable by models/calibration.json). */
export const DEFAULT_HANDWRITING_SCALES = Object.freeze({
  slantDeg: 4,
  strokeWidthRatio: 0.035,
  wordGapRatio: 0.25,
  charGapRatio: 0.08,
  lineSpacingRatio: 0.35,
  baselineVariation: 0.03,
  componentAspect: 0.15,
  ascenderRate: 0.06,
  connectedness: 0.25,
  inkDensity: 0.035,
  marginRegularity: 0.025,
  compactness: 0.6,
  writingSize: 0.006,
  slantSpread: 3,
  hingeWeight: 0,
  whiteRunWeight: 0,
});

export const HANDWRITING_FEATURE_INFO = {
  slantDeg: 'Dominant writing slant in degrees (positive = leaning right)',
  slantSpread: 'Variation of slant between lines (degrees)',
  strokeWidthRatio: 'Estimated stroke width relative to line height',
  wordGapRatio: 'Typical space between words relative to line height',
  charGapRatio: 'Typical gap inside words relative to line height',
  lineSpacingRatio: 'Distance between lines relative to line height',
  baselineVariation: 'How much words wander above/below the baseline',
  componentAspect: 'Typical height-to-width proportion of letter shapes',
  ascenderRate: 'Share of tall letter shapes (ascenders / capitals)',
  connectedness: 'Average width of connected strokes relative to line height (higher = more joined-up)',
  inkDensity: 'Ink coverage inside the writing area',
  marginRegularity: 'Variation of the left margin (lower = straighter alignment)',
  compactness: 'Contour complexity of letter shapes',
  writingSize: 'Line height relative to page width (writing size)',
};

/** Shear-based slant estimate for a set of ink points of one band. */
function slantOf(points, y0, height, angles) {
  let best = 0;
  let bestScore = -Infinity;
  const bins = new Map();
  for (const a of angles) {
    const t = Math.tan((a * Math.PI) / 180);
    bins.clear();
    for (const [x, y] of points) {
      const xs = Math.round(x + (y - (y0 + height)) * t);
      bins.set(xs, (bins.get(xs) || 0) + 1);
    }
    let score = 0;
    for (const v of bins.values()) score += v * v;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

function runLengths(mask, w, h, lines) {
  const runs = [];
  for (const l of lines) {
    for (let y = l.y0; y <= l.y1; y += 2) {
      let run = 0;
      for (let x = l.x0; x <= l.x1 + 1; x++) {
        if (x <= l.x1 && mask[y * w + x]) run++;
        else if (run) { runs.push(run); run = 0; }
      }
    }
    for (let x = l.x0; x <= l.x1; x += 2) {
      let run = 0;
      for (let y = l.y0; y <= l.y1 + 1; y++) {
        if (y <= l.y1 && mask[y * w + x]) run++;
        else if (run) { runs.push(run); run = 0; }
      }
    }
  }
  return runs;
}

/** Split gap lengths into intra-word and inter-word gaps (1-D two-means). */
function splitGaps(gaps) {
  if (gaps.length < 4) return { intra: gaps, inter: [] };
  const s = [...gaps].sort((a, b) => a - b);
  let best = { cost: Infinity, k: 1 };
  for (let k = 1; k < s.length; k++) {
    const a = s.slice(0, k);
    const b = s.slice(k);
    const cost = a.length * std(a) ** 2 + b.length * std(b) ** 2;
    if (cost < best.cost) best = { cost, k };
  }
  return { intra: s.slice(0, best.k), inter: s.slice(best.k) };
}

/**
 * Extract handwriting features from a preprocessPage() result.
 */
export function extractHandwritingFeatures(pre) {
  const { mask, width: w, height: h, lines, image } = pre;
  const warnings = [];
  const usable = lines.filter((l) => l.x1 - l.x0 > l.height * 2);
  if (usable.length < 3) warnings.push(`Only ${usable.length} usable text line(s) were found; at least 3 are needed for stable measurements.`);
  if (!usable.length) return { ok: false, warnings: [...warnings, 'No handwriting lines could be segmented.'], lines: 0 };

  const H = median(usable.map((l) => l.height));
  const { comps } = connectedComponents(mask, w, h);
  const minArea = Math.max(6, (H * H) / 400);
  const letters = comps.filter((c) => c.area >= minArea && c.h < H * 3 && c.w < w * 0.6);
  if (letters.length < 40) warnings.push(`Only ${letters.length} letter shapes were detected; results may be unstable.`);

  const angles = [];
  for (let a = -45; a <= 45; a += 1.5) angles.push(a);
  const pts = inkPoints(mask, w, h, 40000);
  const perLine = usable.map((l) => {
    const lp = pts.filter(([x, y]) => y >= l.y0 && y <= l.y1);
    const slant = lp.length > 30 ? slantOf(lp, l.y0, l.height, angles) : 0;
    // word segmentation on this line
    const prof = colProfile(mask, w, l.y0, l.y1 + 1);
    const gaps = [];
    const segments = [];
    let inSeg = false;
    let segStart = 0;
    let gapLen = 0;
    for (let x = l.x0; x <= l.x1; x++) {
      if (prof[x] > 0) {
        if (!inSeg) {
          if (segments.length) gaps.push(gapLen);
          segStart = x;
          inSeg = true;
        }
      } else {
        if (inSeg) { segments.push([segStart, x - 1]); inSeg = false; gapLen = 0; }
        gapLen++;
      }
    }
    if (inSeg) segments.push([segStart, l.x1]);
    // baseline of each segment: lowest row still holding ≥ 15% of the segment's peak row ink
    const baselines = [];
    for (const [s0, s1] of segments) {
      if (s1 - s0 < H * 0.3) continue;
      const rows = [];
      for (let y = l.y0; y <= l.y1; y++) { let c = 0; for (let x = s0; x <= s1; x++) c += mask[y * w + x]; rows.push(c); }
      const peak = Math.max(...rows);
      let b = rows.length - 1;
      while (b > 0 && rows[b] < peak * 0.15) b--;
      baselines.push({ x: (s0 + s1) / 2, y: l.y0 + b });
    }
    let baseDev = 0;
    if (baselines.length >= 3) {
      const mx = mean(baselines.map((p) => p.x));
      const my = mean(baselines.map((p) => p.y));
      let sxy = 0; let sxx = 0;
      for (const p of baselines) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
      const slope = sxx ? sxy / sxx : 0;
      baseDev = std(baselines.map((p) => p.y - (my + slope * (p.x - mx)))) / H;
    }
    const inkArea = (l.x1 - l.x0 + 1) * l.height;
    return { slant, gaps, baseDev, x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1, height: l.height, density: l.ink / inkArea };
  });

  const allGaps = perLine.flatMap((p) => p.gaps).filter((g) => g >= 1);
  const { intra, inter } = splitGaps(allGaps);
  const runs = runLengths(mask, w, h, usable);
  const centres = usable.map((l) => (l.y0 + l.y1) / 2);
  const spacings = centres.slice(1).map((c, i) => c - centres[i]);
  const blockW = Math.max(...usable.map((l) => l.x1)) - Math.min(...usable.map((l) => l.x0)) + 1;
  const compH = median(letters.map((c) => c.h)) || 1;

  let perimeterSum = [];
  for (const c of letters.slice(0, 400)) {
    // Approximate contour complexity from bounding-box fill: perimeter² / (4π·area)
    const per = 2 * (c.w + c.h);
    perimeterSum.push((per * per) / (4 * Math.PI * c.area));
  }

  const features = {
    slantDeg: median(perLine.map((p) => p.slant)),
    slantSpread: std(perLine.map((p) => p.slant)),
    strokeWidthRatio: median(runs) / H,
    wordGapRatio: inter.length ? median(inter) / H : 0,
    charGapRatio: intra.length ? median(intra) / H : 0,
    lineSpacingRatio: spacings.length ? median(spacings) / H : 0,
    baselineVariation: median(perLine.map((p) => p.baseDev)),
    componentAspect: median(letters.map((c) => c.h / c.w)),
    ascenderRate: letters.filter((c) => c.h > compH * 1.5).length / (letters.length || 1),
    connectedness: median(letters.map((c) => c.w)) / H,
    inkDensity: median(perLine.map((p) => p.density)),
    marginRegularity: std(usable.map((l) => l.x0)) / (blockW || 1),
    compactness: median(perimeterSum),
    writingSize: H / w,
  };

  const orientHist = orientationHistogram(image, mask, 12);
  const lbp = lbpHistogram(image, mask);
  const hinge = edgeHinge(mask, w, h);
  const whiteRuns = whiteRunHistogram(mask, w, usable);
  const heightsCv = std(letters.map((c) => c.h)) / (mean(letters.map((c) => c.h)) || 1);

  // Heuristic printed-vs-handwritten indicator (explainable, not a classifier).
  const cues = [];
  if (features.baselineVariation > 0.035) cues.push('irregular baseline');
  if (Math.abs(features.slantDeg) > 5) cues.push('noticeable slant');
  if (features.slantSpread > 2.5) cues.push('slant varies between lines');
  if (heightsCv > 0.45) cues.push('irregular letter heights');
  if (features.connectedness > 0.9) cues.push('joined-up strokes');

  return {
    ok: true,
    warnings,
    lines: usable.length,
    letters: letters.length,
    lineHeightPx: H,
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, round(v, 4)])),
    histograms: { orientation: orientHist.map((v) => round(v, 4)), texture: lbp.map((v) => round(v, 4)), hinge: hinge.map((v) => round(v, 5)), whiteRuns: whiteRuns.map((v) => round(v, 4)) },
    perLine: perLine.map((p) => ({ slant: p.slant, baseDev: round(p.baseDev, 4), height: p.height, density: round(p.density, 4), y0: p.y0, y1: p.y1, x0: p.x0, x1: p.x1 })),
    handwritingCues: cues,
    looksHandwritten: cues.length >= 2,
  };
}

/** Compare two handwriting feature sets. */
export function compareHandwriting(fa, fb, scales = DEFAULT_HANDWRITING_SCALES) {
  const sc = { ...DEFAULT_HANDWRITING_SCALES, ...scales };
  const features = Object.keys(HANDWRITING_FEATURE_INFO).map((name) => {
    const a = fa.features[name];
    const b = fb.features[name];
    const z = Math.abs(a - b) / sc[name];
    return { name, label: HANDWRITING_FEATURE_INFO[name], a, b, z: round(z, 2), verdict: z < 1 ? 'similar' : z < 2 ? 'partial' : 'different' };
  });
  const orientationSimilarity = round(histSimilarity(fa.histograms.orientation, fb.histograms.orientation), 4);
  const textureSimilarity = round(histSimilarity(fa.histograms.texture, fb.histograms.texture), 4);
  const hingeSimilarity = fa.histograms.hinge && fb.histograms.hinge ? round(histSimilarity(fa.histograms.hinge, fb.histograms.hinge), 4) : null;
  const whiteRunSimilarity = fa.histograms.whiteRuns && fb.histograms.whiteRuns ? round(histSimilarity(fa.histograms.whiteRuns, fb.histograms.whiteRuns), 4) : null;
  const similar = features.filter((f) => f.verdict === 'similar').length;
  const different = features.filter((f) => f.verdict === 'different').length;
  const warnings = [...fa.warnings, ...fb.warnings];
  const meanZ = mean(features.map((f) => Math.min(f.z, 5)));
  // Combined distance: geometric features plus (optionally) texture evidence. The weights
  // are fitted in notebooks/03 on synthetic writers and shipped via models/calibration.json.
  const w = { hinge: sc.hingeWeight ?? 0, runs: sc.whiteRunWeight ?? 0 };
  const distance = meanZ + w.hinge * (1 - (hingeSimilarity ?? 1)) + w.runs * (1 - (whiteRunSimilarity ?? 1));
  return {
    features,
    orientationSimilarity,
    textureSimilarity,
    hingeSimilarity,
    whiteRunSimilarity,
    distance: round(distance, 3),
    agreement: round(similar / features.length, 4),
    disagreement: round(different / features.length, 4),
    meanZ: round(meanZ, 3),
    warnings,
    reliable: fa.lines >= 3 && fb.lines >= 3 && fa.letters >= 40 && fb.letters >= 40,
  };
}
