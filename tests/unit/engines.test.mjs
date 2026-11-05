// Analysis-engine unit tests (text, style, handwriting, signature, layout, anomaly, fusion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareTexts, sharedPassages } from '../../js/engines/text-similarity.js';
import { splitSentences, splitParagraphs, tokenize } from '../../js/engines/text-utils.js';
import { extractStyleFeatures, compareStyle, clusterByStyle, FEATURE_INFO } from '../../js/engines/stylometry.js';
import { preprocessPage } from '../../js/engines/preprocess.js';
import { extractHandwritingFeatures, compareHandwriting } from '../../js/engines/handwriting.js';
import { normalizeSignature, compareSignatures } from '../../js/engines/signature.js';
import { extractLayout, compareLayout } from '../../js/engines/layout.js';
import { robustZ, isolationScores, metadataConsistency, textConsistency } from '../../js/engines/anomaly.js';
import { investigateSources, pageOf } from '../../js/engines/source-matching.js';
import { fuseEvidence } from '../../js/core/fusion.js';
import { ssim, otsu, makeGray, estimateSkew, binarize, rotate } from '../../js/engines/imaging.js';
import { decodePngGray } from '../../tools/png-gray.mjs';

const FX = (n) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
const txt = (n) => readFileSync(FX(n), 'utf8');
const A = { id: 'a', text: txt('essay_a.txt') };
const B = { id: 'b', text: txt('essay_b.txt') };
const C = { id: 'c', text: txt('essay_c.txt') };

// ---------- text utilities ----------
test('sentence and paragraph segmentation keep offsets', () => {
  const t = 'Dr. Smith arrived. He was late!\n\nNew paragraph here? Yes.';
  const s = splitSentences(t);
  assert.equal(s.length, 4);
  assert.equal(s[0].text, 'Dr. Smith arrived.');
  for (const x of s) assert.equal(t.slice(x.start, x.end), x.text);
  assert.equal(splitParagraphs(t).length, 2);
});

// ---------- text similarity ----------
test('identical documents are detected as exact', () => {
  const r = compareTexts(A, { id: 'x', text: A.text });
  assert.equal(r.metrics.exactDocument, true);
  assert.equal(r.metrics.sharedPassageCoverageA, 1);
});

test('copied passages and paraphrases are found between A and B, with valid offsets', () => {
  const r = compareTexts(A, B);
  assert.ok(r.passages.length >= 2, 'expected shared passages');
  for (const p of r.passages) {
    const ta = tokenize(A.text.slice(p.a.start, p.a.end)).join(' ');
    const tb = tokenize(B.text.slice(p.b.start, p.b.end)).join(' ');
    assert.equal(ta, tb, 'highlighted passages must be identical word sequences');
  }
  assert.ok(r.counts.exact >= 2);
  assert.ok(r.counts.possible_paraphrase + r.counts.near_identical >= 1, 'paraphrased sentence should be flagged');
  assert.ok(r.uniqueA.length >= 1 && r.uniqueB.length >= 1);
  assert.ok(r.metrics.sharedPassageCoverageA > 0.15);
});

test('unrelated documents score low', () => {
  const r = compareTexts(A, C);
  assert.equal(r.passages.length, 0);
  assert.ok(r.metrics.tfidfCosine < 0.2);
  assert.ok(r.metrics.sharedPassageCoverageA === 0);
});

test('short texts are flagged and empty texts are insufficient', () => {
  assert.ok(compareTexts({ id: 1, text: 'one two three' }, { id: 2, text: 'one two three' }).warnings.length);
  assert.equal(compareTexts({ id: 1, text: '' }, B).status, 'insufficient');
});

test('shared passage search respects minimum length', () => {
  const r = sharedPassages('a b c d e f g', 'a b c d e f g', 8);
  assert.equal(r.passages.length, 0);
});

// ---------- source matching ----------
test('source investigation reports pages and methods', () => {
  const r = investigateSources([{ id: 'b', name: 'B', text: B.text, pageStarts: [0] }], [{ id: 'a', name: 'A', text: A.text, pageStarts: [0, 600] }]);
  const res = r.results[0];
  assert.ok(res.combinedCoverage > 0.1);
  assert.ok(res.sources[0].matches.some((m) => m.method === 'Exact shared passage'));
  assert.equal(pageOf(700, [0, 600]), 2);
  assert.match(r.scope, /No internet/);
});

// ---------- stylometry ----------
test('style features: 57 named features, sensible values', () => {
  const f = extractStyleFeatures(A.text);
  assert.equal(Object.keys(f.features).length, Object.keys(FEATURE_INFO).length);
  assert.equal(Object.keys(FEATURE_INFO).length, 57);
  assert.ok(f.features.avgSentenceLength > 10 && f.features.avgSentenceLength < 30);
  assert.ok(f.features.mattr > 0.5 && f.features.mattr <= 1);
});

test('style comparison warns on short texts and explains features', () => {
  const r = compareStyle(A, C);
  assert.equal(r.status, 'limited');
  assert.ok(r.features.every((x) => ['match', 'partial', 'differs'].includes(x.verdict)));
  assert.ok(r.strongestDifferences.length === 6);
});

const gut = (name) => {
  try { return readFileSync(fileURLToPath(new URL(`../../notebooks/data/gutenberg/${name}`, import.meta.url)), 'utf8'); } catch { return null; }
};
test('style: same-author chunks agree more than different-author chunks (if corpus present)', { skip: !gut('austen-emma.txt') }, () => {
  const emma = gut('austen-emma.txt');
  const pers = gut('austen-persuasion.txt');
  const mel = gut('melville-moby_dick.txt');
  const take = (t, start) => t.split(/\s+/).slice(start, start + 2500).join(' ');
  const same = compareStyle({ id: 1, text: take(emma, 20000) }, { id: 2, text: take(pers, 20000) });
  const diff = compareStyle({ id: 1, text: take(emma, 20000) }, { id: 3, text: take(mel, 20000) });
  assert.ok(same.agreement > diff.agreement, `same ${same.agreement} vs diff ${diff.agreement}`);
});

test('style clustering groups documents', () => {
  const r = clusterByStyle([A, B, C]);
  assert.equal(r.clusters.flat().length, 3);
});

// ---------- imaging ----------
test('ssim of identical images is 1; otsu splits bimodal data', () => {
  const g = makeGray(32, 32, new Uint8ClampedArray(32 * 32).map((_, i) => (i % 7) * 30));
  assert.ok(Math.abs(ssim(g, g).mean - 1) < 1e-9);
  const bi = makeGray(10, 10, new Uint8ClampedArray(100).map((_, i) => (i < 50 ? 20 : 230)));
  const t = otsu(bi);
  assert.ok(t >= 20 && t < 230);
});

test('skew estimation recovers a known rotation', () => {
  const scan = decodePngGray(FX('scan_a.png'));
  const small = { ...scan };
  const mask = binarize(small);
  const est = estimateSkew(mask, small.width, small.height);
  assert.ok(Math.abs(est - -1.2) < 0.6 || Math.abs(est - 1.2) < 0.6, `estimated ${est}`);
  const rot = rotate(small, 3);
  const est2 = estimateSkew(binarize(rot), rot.width, rot.height);
  assert.ok(Math.abs(Math.abs(est2 - est) - 3) < 0.6, `rotating by 3° should shift the estimate by 3° (got ${est} → ${est2})`);
});

// ---------- preprocessing, handwriting, layout ----------
const pre = (n) => preprocessPage(decodePngGray(FX(n)), { maxSide: 1400 });

test('preprocessing records operations and finds lines on a printed page', () => {
  const p = pre('scan_a.png');
  assert.ok(p.lines.length >= 15, `lines ${p.lines.length}`);
  assert.ok(p.operations.some((o) => /Deskewed/.test(o)));
  assert.match(p.orientation.orientation, /upright/);
});

test('handwriting features: same synthetic writer closer than different writer', () => {
  const w1a = extractHandwritingFeatures(pre('hand_writer1_a.png'));
  const w1b = extractHandwritingFeatures(pre('hand_writer1_b.png'));
  const w2 = extractHandwritingFeatures(pre('hand_writer2_a.png'));
  assert.ok(w1a.ok && w1b.ok && w2.ok);
  assert.ok(w1a.features.slantDeg > 8, `slant ${w1a.features.slantDeg}`);
  assert.ok(w2.features.slantDeg < 5, `slant ${w2.features.slantDeg}`);
  const same = compareHandwriting(w1a, w1b);
  const diff = compareHandwriting(w1a, w2);
  assert.ok(same.meanZ < diff.meanZ, `same ${same.meanZ} diff ${diff.meanZ}`);
  assert.ok(w1a.looksHandwritten);
});

test('printed page is not flagged as handwritten', () => {
  const p = extractHandwritingFeatures(pre('scan_a.png'));
  assert.equal(p.looksHandwritten, false, p.handwritingCues.join(','));
});

test('layout of the same page vs a different page', () => {
  const la = extractLayout(pre('scan_a.png'));
  const lh = extractLayout(pre('hand_writer2_a.png'));
  assert.ok(la.ok && lh.ok);
  assert.equal(compareLayout(la, la).agreement, 1);
  assert.ok(compareLayout(la, lh).agreement < 1);
});

// ---------- signature ----------
test('signatures: same synthetic signer more similar than different signer', () => {
  const s1a = normalizeSignature(decodePngGray(FX('sig_person1_a.png')));
  const s1b = normalizeSignature(decodePngGray(FX('sig_person1_b.png')));
  const s2 = normalizeSignature(decodePngGray(FX('sig_person2_a.png')));
  const same = compareSignatures(s1a, s1b);
  const diff = compareSignatures(s1a, s2);
  assert.ok(same.metrics.tolerantOverlap > diff.metrics.tolerantOverlap);
  assert.ok(same.metrics.chamferDistancePx < diff.metrics.chamferDistancePx);
  assert.equal(same.diffMap.length, 384 * 160);
});

test('blank region yields no signature', () => {
  const blank = makeGray(200, 100, new Uint8ClampedArray(20000).fill(250));
  assert.equal(normalizeSignature(blank).ok, false);
});

// ---------- anomaly ----------
test('robust z and isolation forest single out an outlier', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ x: 10 + (i % 3) * 0.1, y: 5 + (i % 2) * 0.1 }));
  rows.push({ x: 40, y: 30 });
  const z = robustZ(rows, ['x', 'y']);
  assert.ok(Math.abs(z[20].x) > 10);
  const iso = isolationScores(rows, ['x', 'y']);
  assert.equal(iso.indexOf(Math.max(...iso)), 20);
});

test('inserted text in a different style is flagged', () => {
  const base = Array.from({ length: 12 }, () => A.text.split('\n\n')[0]).join('\n\n');
  const odd = 'WOW!!! THIS IS AMAZING!!! YOU WON\'T BELIEVE IT!!! CLICK NOW!!! BUY BUY BUY!!! '.repeat(14);
  const r = textConsistency(`${base}\n\n${odd}\n\n${base}`);
  assert.ok(r.ok);
  assert.ok(r.flags.length >= 1, 'expected a flagged segment');
});

test('metadata: modification before creation is flagged', () => {
  const r = metadataConsistency({ CreationDate: 'D:20240510120000', ModDate: 'D:20230101000000' });
  assert.equal(r.flags.length, 1);
});

// ---------- fusion ----------
test('fusion labels, never averages, and reports conflicts', () => {
  const text = compareTexts(A, B);
  const style = { ...compareStyle(A, B), pair: ['a', 'b'], agreement: 0.2, disagreement: 0.5, words: { a: 400, b: 400 }, status: 'ok' };
  const docs = new Map([['a', { displayName: 'A' }], ['b', { displayName: 'B' }]]);
  const f = fuseEvidence({ text: { pairs: [text] }, style: { pairs: [style] } }, docs, ['text', 'style', 'signature']);
  const t = f.rows.find((r) => r.module === 'text');
  assert.ok(['High', 'Moderate'].includes(t.label));
  assert.equal(f.status.signature.state, 'not run');
  assert.ok(!JSON.stringify(f).match(/probab/i), 'fusion must not output probabilities');
  if (t.label === 'High') assert.ok(f.conflicts.length >= 1);
});
