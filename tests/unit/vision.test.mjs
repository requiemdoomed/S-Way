// Computer-vision tests: perspective correction, copy-move screening, writer texture features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { homography, applyH, findPaperQuad, edgeHinge, whiteRunHistogram, makeGray } from '../../js/engines/imaging.js';
import { preprocessPage } from '../../js/engines/preprocess.js';
import { detectDuplicatedRegions, verify } from '../../js/engines/tamper.js';
import { extractHandwritingFeatures, compareHandwriting } from '../../js/engines/handwriting.js';
import { decodePngGray } from '../../tools/png-gray.mjs';

const FX = (n) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
const load = (n) => decodePngGray(FX(n));

test('homography maps the four control points exactly', () => {
  const from = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const to = [[10, 5], [120, 12], [115, 70], [3, 60]];
  const H = homography(from, to);
  from.forEach((p, i) => {
    const [x, y] = applyH(H, ...p);
    assert.ok(Math.abs(x - to[i][0]) < 1e-6 && Math.abs(y - to[i][1]) < 1e-6);
  });
});

test('photographed page: sheet corners found and perspective corrected', () => {
  const photo = load('photo_page.png');
  const quad = findPaperQuad(photo);
  assert.ok(quad && quad.skewed, 'sheet should be detected as a skewed quadrilateral');
  const expected = [[170, 140], [1330, 210], [1390, 1760], [110, 1690]];
  quad.corners.forEach((c, i) => assert.ok(Math.hypot(c[0] - expected[i][0], c[1] - expected[i][1]) < 25, `corner ${i} at ${c}`));
  const pre = preprocessPage(photo);
  assert.equal(pre.boundary.kind, 'perspective');
  assert.ok(pre.operations.some((o) => /perspective/.test(o)));
  const flat = preprocessPage(load('scan_a.png'));
  assert.ok(Math.abs(pre.lines.length - flat.lines.length) <= 2, `lines ${pre.lines.length} vs ${flat.lines.length}`);
  assert.ok(Math.abs(pre.skewDeg) < 1.5);
});

test('flat scans and white-background images are not "corrected"', () => {
  assert.equal(findPaperQuad(load('scan_a.png')), null);
  assert.equal(findPaperQuad(load('hand_writer1_a.png')), null);
});

test('copy-move: pasted region is found and localised; clean pages produce no alarms', () => {
  const r = detectDuplicatedRegions(load('tampered_copy_move.png'));
  assert.equal(r.regions.length, 1);
  const { source, copy, correlation } = r.regions[0];
  // fixture: crop (140,160)-(520,300) pasted at (560,1250)
  assert.ok(Math.abs(source.x - 140) < 30 && Math.abs(source.y - 160) < 30, JSON.stringify(source));
  assert.ok(Math.abs(copy.x - 560) < 30 && Math.abs(copy.y - 1250) < 30, JSON.stringify(copy));
  assert.ok(correlation > 0.95);
  for (const n of ['scan_a.png', 'hand_writer1_a.png', 'hand_writer1_b.png', 'hand_writer2_a.png', 'sig_person1_a.png']) {
    assert.equal(detectDuplicatedRegions(load(n)).regions.length, 0, `false alarm on ${n}`);
  }
});

test('copy-move verification correlation is 1 for identical regions', () => {
  const g = makeGray(40, 20, new Uint8ClampedArray(800).map((_, i) => ((i * 37) % 251)));
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) g.data[y * 40 + x + 20] = g.data[y * 40 + x];
  assert.ok(verify(g, { x: 0, y: 0, w: 10, h: 20 }, { x: 20, y: 0, w: 10, h: 20 }) > 0.99);
});

test('edge-hinge and white-run histograms are normalised distributions', () => {
  const pre = preprocessPage(load('hand_writer1_a.png'));
  const hinge = edgeHinge(pre.mask, pre.width, pre.height);
  const runs = whiteRunHistogram(pre.mask, pre.width, pre.lines);
  assert.equal(hinge.length, 66);
  assert.ok(Math.abs(hinge.reduce((a, c) => a + c, 0) - 1) < 1e-9);
  assert.ok(Math.abs(runs.reduce((a, c) => a + c, 0) - 1) < 1e-9);
});

test('edge-hinge separates synthetic writers', () => {
  const f = (n) => extractHandwritingFeatures(preprocessPage(load(n)));
  const a = f('hand_writer1_a.png');
  const same = compareHandwriting(a, f('hand_writer1_b.png'));
  const diff = compareHandwriting(a, f('hand_writer2_a.png'));
  assert.ok(same.hingeSimilarity > diff.hingeSimilarity + 0.2, `${same.hingeSimilarity} vs ${diff.hingeSimilarity}`);
  assert.ok(same.distance < diff.distance);
});
