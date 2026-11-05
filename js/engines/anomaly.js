/**
 * MODULE 9 — Anomaly and Consistency Screening.
 *
 * Looks *inside* a single document for regions that behave differently from the
 * rest: sudden writing-style shifts between text segments, handwriting lines whose
 * slant/size/density differ, layout breaks, and metadata inconsistencies.
 *
 * Method: robust z-scores (median / MAD) per feature across segments, combined into
 * a per-segment outlier score; plus an Isolation-Forest-style isolation depth for a
 * second opinion. Every flag lists the features that triggered it.
 *
 * An anomaly is an investigation lead. Legitimate causes include quotations, lists,
 * tables, changes of topic, tiredness, a different pen, or editing over time.
 */
import { chunkText, extractStyleFeatures } from './stylometry.js';
import { median, mean } from './text-utils.js';
import { round } from './imaging.js';

const TEXT_FEATURES = ['avgSentenceLength', 'avgWordLength', 'mattr', 'longWordRate', 'punct_comma', 'transitionRate', 'fw_the', 'fw_of', 'fw_and', 'capitalRate', 'contractionRate', 'openPronoun'];

/** Robust z-scores (0.6745·(x − median)/MAD) for each column. */
export function robustZ(rows, keys) {
  const stats = {};
  for (const k of keys) {
    const vals = rows.map((r) => r[k]);
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    const scale = mad > 1e-9 ? mad / 0.6745 : (mean(vals.map((v) => Math.abs(v - med))) * 1.253 || 1e-9);
    stats[k] = { med, scale };
  }
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, (r[k] - stats[k].med) / stats[k].scale])));
}

/** Deterministic pseudo-random generator so results are reproducible run-to-run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Small Isolation Forest: average isolation path length per row (shorter = more anomalous). */
export function isolationScores(rows, keys, trees = 100, seed = 42) {
  const n = rows.length;
  if (n < 4) return rows.map(() => 0);
  const rand = rng(seed);
  const sample = Math.min(64, n);
  const c = (m) => (m <= 1 ? 0 : 2 * (Math.log(m - 1) + 0.5772156649) - (2 * (m - 1)) / m);
  const depthSum = new Float64Array(n);
  const build = (idx, depth, limit) => {
    if (depth >= limit || idx.length <= 1) return { leaf: true, size: idx.length };
    const k = keys[Math.floor(rand() * keys.length)];
    let lo = Infinity; let hi = -Infinity;
    for (const i of idx) { lo = Math.min(lo, rows[i][k]); hi = Math.max(hi, rows[i][k]); }
    if (hi - lo < 1e-12) return { leaf: true, size: idx.length };
    const split = lo + rand() * (hi - lo);
    return { k, split, left: build(idx.filter((i) => rows[i][k] < split), depth + 1, limit), right: build(idx.filter((i) => rows[i][k] >= split), depth + 1, limit) };
  };
  const path = (node, row, depth) => (node.leaf ? depth + c(node.size) : path(row[node.k] < node.split ? node.left : node.right, row, depth + 1));
  const limit = Math.ceil(Math.log2(sample));
  for (let t = 0; t < trees; t++) {
    const idx = [];
    for (let i = 0; i < sample; i++) idx.push(Math.floor(rand() * n));
    const tree = build(idx, 0, limit);
    for (let i = 0; i < n; i++) depthSum[i] += path(tree, rows[i], 0);
  }
  return Array.from(depthSum, (d) => round(2 ** (-(d / trees) / c(sample)), 4)); // >0.6 ≈ anomalous
}

function flagRows(rows, keys, labelFor, describe) {
  const z = robustZ(rows, keys);
  const iso = isolationScores(rows, keys);
  const flags = [];
  rows.forEach((r, i) => {
    const strong = keys.filter((k) => Math.abs(z[i][k]) >= 3.5).sort((a, b) => Math.abs(z[i][b]) - Math.abs(z[i][a]));
    if (strong.length >= 2 || (strong.length >= 1 && iso[i] > 0.62)) {
      flags.push({
        segment: labelFor(i),
        index: i,
        isolationScore: iso[i],
        features: strong.slice(0, 4).map((k) => ({ feature: k, description: describe(k), robustZ: round(z[i][k], 2), value: round(r[k], 4) })),
      });
    }
  });
  return { flags, isolation: iso };
}

/** Writing-style consistency across consecutive ~150-word segments of one text. */
export function textConsistency(text, chunkWords = 150) {
  const chunks = chunkText(text, chunkWords);
  if (chunks.length < 5) {
    return { ok: false, segments: chunks.length, reason: `At least 5 segments of ~${chunkWords} words are needed for internal style screening (found ${chunks.length}).`, flags: [] };
  }
  const rows = chunks.map((c) => extractStyleFeatures(c).features);
  const { flags, isolation } = flagRows(rows, TEXT_FEATURES, (i) => `Text segment ${i + 1} of ${chunks.length}`, (k) => k);
  let offset = 0;
  const spans = chunks.map((c) => { const s = text.indexOf(c.slice(0, 40), offset); offset = s >= 0 ? s + 1 : offset; return s; });
  for (const f of flags) f.excerpt = chunks[f.index].slice(0, 220);
  return { ok: true, segments: chunks.length, flags, isolation, segmentStarts: spans, method: 'Robust z-scores (median/MAD) and Isolation Forest over 12 stylometric features per segment.' };
}

/** Handwriting consistency across text lines (per-line slant, height, density, baseline). */
export function handwritingConsistency(perLine) {
  if (!perLine || perLine.length < 6) return { ok: false, reason: 'At least 6 handwriting lines are needed for line-level screening.', flags: [] };
  const H = median(perLine.map((p) => p.height));
  const rows = perLine.map((p) => ({ slant: p.slant, height: p.height / H, density: p.density, baseline: p.baseDev }));
  const desc = { slant: 'Line slant', height: 'Line height (writing size)', density: 'Ink density', baseline: 'Baseline wobble' };
  const { flags } = flagRows(rows, Object.keys(desc), (i) => `Handwriting line ${i + 1}`, (k) => desc[k]);
  for (const f of flags) f.region = { y0: perLine[f.index].y0, y1: perLine[f.index].y1, x0: perLine[f.index].x0, x1: perLine[f.index].x1 };
  return { ok: true, lines: perLine.length, flags, method: 'Robust z-scores and Isolation Forest over per-line slant, height, ink density and baseline variation.' };
}

/** Page-to-page layout consistency within one document. */
export function layoutConsistency(pages) {
  const usable = pages.filter((p) => p && p.ok);
  if (usable.length < 3) return { ok: false, reason: 'At least 3 analysed pages are needed for page-level layout screening.', flags: [] };
  const keys = ['marginLeft', 'marginRight', 'marginTop', 'lineSpacing', 'lineHeight', 'textDensity'];
  const rows = usable.map((p) => p.features);
  const { flags } = flagRows(rows, keys, (i) => `Page ${usable[i].page}`, (k) => k);
  return { ok: true, pages: usable.length, flags };
}

/** PDF metadata checks. Dates are compared; tool names are reported, never judged. */
export function metadataConsistency(meta) {
  if (!meta) return { ok: false, flags: [], notes: ['No metadata available for this format.'] };
  const notes = [];
  const flags = [];
  const parse = (d) => {
    if (!d) return null;
    const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(d);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0));
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const created = parse(meta.CreationDate);
  const modified = parse(meta.ModDate);
  if (created && modified && modified < created) flags.push({ issue: 'The modification date is earlier than the creation date.', detail: 'This can result from clock differences, conversion tools or editing; it is not evidence of tampering by itself.' });
  if (created && created > new Date(Date.now() + 86400000)) flags.push({ issue: 'The creation date is in the future.', detail: 'Often caused by an incorrect device clock.' });
  if (created && modified && modified - created > 0) notes.push(`Modified ${Math.round((modified - created) / 86400000)} day(s) after creation.`);
  if (meta.Producer && meta.Creator && meta.Producer !== meta.Creator) notes.push('Created and produced by different software (normal for exported or converted files).');
  return { ok: true, flags, notes };
}
