#!/usr/bin/env node
/**
 * Research bridge used by the Jupyter notebooks: runs the SAME JavaScript engines the
 * browser app ships, so evaluation results describe the real implementation.
 *
 * Usage: node tools/sway-cli.mjs request.json > response.json
 * request.json: { "tasks": [ { "op": "...", ...args }, ... ] }
 * Ops: text, style, styleFeatures, preprocess, hwFeatures, hwCompare, signature, paperQuad, tamper
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareTexts } from '../js/engines/text-similarity.js';
import { compareStyle, extractStyleFeatures } from '../js/engines/stylometry.js';
import { preprocessPage } from '../js/engines/preprocess.js';
import { extractHandwritingFeatures, compareHandwriting } from '../js/engines/handwriting.js';
import { normalizeSignature, compareSignatures } from '../js/engines/signature.js';
import { decodePngGray } from './png-gray.mjs';
import { findPaperQuad } from '../js/engines/imaging.js';
import { detectDuplicatedRegions } from '../js/engines/tamper.js';

const ops = {
  text: ({ a, b, thresholds }) => {
    const r = compareTexts({ id: 'a', text: a }, { id: 'b', text: b }, thresholds);
    return { metrics: r.metrics, counts: r.counts, words: r.words, status: r.status };
  },
  style: ({ a, b }) => {
    const r = compareStyle({ id: 'a', text: a }, { id: 'b', text: b });
    return { agreement: r.agreement, disagreement: r.disagreement, cosine: r.cosineStandardized, distance: r.standardizedDistance, words: r.words };
  },
  styleFeatures: ({ text }) => extractStyleFeatures(text).features,
  preprocess: ({ png, out }) => {
    const p = preprocessPage(decodePngGray(png));
    // Optionally write the cleaned working copy as a binary PGM so Python can inspect or OCR it.
    if (out) writeFileSync(out, Buffer.concat([Buffer.from(`P5 ${p.width} ${p.height} 255\n`), Buffer.from(p.image.data)]));
    return { lines: p.lines.length, skewDeg: p.skewDeg, quality: p.quality, boundary: p.boundary, width: p.width, height: p.height, operations: p.operations };
  },
  paperQuad: ({ png }) => findPaperQuad(decodePngGray(png)),
  tamper: ({ png, opts }) => {
    // Same configuration as the app: line height from preprocessing (without deskew, so that
    // coordinates stay in the original image frame for comparison with ground truth).
    const g = decodePngGray(png);
    const p = preprocessPage(g, { deskew: false });
    const hs = p.lines.map((l) => l.height).sort((a, b) => a - b);
    const lineHeight = hs.length ? (hs[hs.length >> 1] * g.width) / p.width : 0;
    return detectDuplicatedRegions(g, { lineHeight, ...(opts || {}) });
  },
  hwFeatures: ({ png }) => {
    const f = extractHandwritingFeatures(preprocessPage(decodePngGray(png)));
    return f.ok ? { ok: true, features: f.features, histograms: f.histograms, lines: f.lines, letters: f.letters, warnings: f.warnings, perLine: f.perLine } : { ok: false, warnings: f.warnings, lines: f.lines || 0, letters: 0 };
  },
  hwCompare: ({ fa, fb, scales }) => { const r = compareHandwriting(fa, fb, scales); return { meanZ: r.meanZ, agreement: r.agreement, orientationSimilarity: r.orientationSimilarity, textureSimilarity: r.textureSimilarity }; },
  signature: ({ a, b }) => {
    const na = normalizeSignature(decodePngGray(a));
    const nb = normalizeSignature(decodePngGray(b));
    if (!na.ok || !nb.ok) return { ok: false };
    return { ok: true, metrics: compareSignatures(na, nb).metrics };
  },
};

const req = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = req.tasks.map((t) => {
  try { return ops[t.op](t); } catch (err) { return { error: String(err.message || err) }; }
});
process.stdout.write(JSON.stringify(out));
