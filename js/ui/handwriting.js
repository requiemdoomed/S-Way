/** Handwriting lab: measure and compare handwriting features of two page images. */
import { h, mount, num } from '../dom.js';
import { session, docList, changed } from '../core/state.js';
import { analysisWorker, startAnalysis } from '../core/orchestrator.js';
import { calibration } from '../core/calibration.js';
import { fuseEvidence } from '../core/fusion.js';
import { limiter } from '../security/rate-limiter.js';
import { HANDWRITING_FEATURE_INFO } from '../engines/handwriting.js';
import { pageHeader, emptyState, linkKey, docPicker, notice, explainError, toast, stamp, table, similarityPhrase, metricList, term } from './common.js';
import { linesOverlay } from './render-helpers.js';
import { barChart } from './charts.js';
import { refreshView } from './bus.js';

const lab = { a: null, b: null, pageA: 0, pageB: 0, busy: false, result: null, key: null };

export function renderHandwriting(root) {
  const docs = docList().filter((d) => d.validation?.accepted && ['png', 'jpeg', 'webp', 'pdf'].includes(d.kind) && d.contentType !== 'signature' && d.contentType !== 'digital')
    .sort((x, y) => (y.contentType === 'handwritten') - (x.contentType === 'handwritten'));
  const header = pageHeader('Handwriting lab', 'Measure slant, spacing, stroke width, baseline and letter proportions on two handwritten pages and compare them feature by feature.',
    notice('warn', 'Feature comparison, not identification.', 'Pens, paper, posture, speed, scanning and deliberate disguise all change handwriting, and different people can share features. Treat results as leads for an expert, never as proof of who wrote a page.'));
  if (docs.length < 2) {
    mount(root, header, emptyState('Add at least two photographed or scanned handwritten pages (PNG, JPEG, WEBP or scanned PDF), and set their content to “Handwritten page”.', linkKey('#/analysis', 'Add documents')));
    return;
  }
  if (!docs.some((d) => d.id === lab.a)) lab.a = docs[0].id;
  if (!docs.some((d) => d.id === lab.b) || lab.b === lab.a) lab.b = docs.find((d) => d.id !== lab.a).id;
  const A = session.docs.get(lab.a);
  const B = session.docs.get(lab.b);
  const unscanned = [A, B].filter((d) => !d.scanned);
  const key = `${A.id}:${lab.pageA}|${B.id}:${lab.pageB}`;
  if (lab.key !== key) lab.result = null;

  const pagePick = (d, k, id) => (d.pages?.length > 1 ? h('div', {}, h('label', { for: id, text: 'Page' }),
    h('select', { id, on: { change: (e) => { lab[k] = Number(e.target.value); refreshView(); } } }, d.pages.map((p, i) => h('option', { value: String(i), selected: lab[k] === i ? true : null, text: `Page ${p.index}` })))) : null);

  mount(root, header,
    h('section', { class: 'sheet paper-grain stack' },
      h('div', { class: 'grid-2' },
        h('div', {}, docPicker('hw-a', docs, lab.a, (v) => { lab.a = v; lab.pageA = 0; refreshView(); }, 'First page image'), pagePick(A, 'pageA', 'hw-pa')),
        h('div', {}, docPicker('hw-b', docs, lab.b, (v) => { lab.b = v; lab.pageB = 0; refreshView(); }, 'Second page image'), pagePick(B, 'pageB', 'hw-pb'))),
      unscanned.length
        ? h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key', disabled: lab.busy ? true : null, on: { click: () => prepare() } }, lab.busy ? 'Preparing pages…' : 'Prepare pages'), h('span', { class: 'fine', text: 'Pages are decoded and read on this device.' }))
        : h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key', disabled: lab.busy ? true : null, on: { click: () => measure(A, B, key) } }, lab.busy ? 'Measuring…' : 'Measure and compare'))),
    lab.result ? results(A, B) : null);
}

async function prepare() {
  try {
    lab.busy = true; refreshView();
    await startAnalysis([], () => {}).promise;
  } catch (err) { toast(explainError(err)); }
  lab.busy = false; refreshView();
}

async function profile(d, i) {
  d.visual ||= [];
  if (!d.visual[i] || !d.visual[i].handwriting) {
    const r = await analysisWorker.call('visualProfile', { gray: d.pages[i].gray, wantHandwriting: true }, { label: 'Measuring handwriting' });
    r.page = d.pages[i].index;
    d.visual[i] = r;
  }
  return d.visual[i];
}

async function measure(A, B, key) {
  try {
    limiter.consume('ml');
    lab.busy = true; refreshView();
    const va = await profile(A, lab.pageA);
    const vb = await profile(B, lab.pageB);
    if (!va.handwriting?.ok || !vb.handwriting?.ok) {
      lab.result = { error: [...(va.handwriting?.warnings || []), ...(vb.handwriting?.warnings || [])].join(' ') || 'No handwriting lines could be measured.' };
    } else {
      const cmp = await analysisWorker.call('handwritingCompare', { fa: va.handwriting, fb: vb.handwriting, scales: calibration.handwritingScales });
      const anA = await analysisWorker.call('anomalyHandwriting', { perLine: va.handwriting.perLine });
      const anB = await analysisWorker.call('anomalyHandwriting', { perLine: vb.handwriting.perLine });
      const fused = fuseEvidence({ handwriting: { pairs: [{ ...cmp, pair: [A.id, B.id] }] } }, session.docs, ['handwriting'], calibration.fusion);
      lab.result = { cmp, va, vb, anA, anB, row: fused.rows[0] };
    }
    lab.key = key;
    changed('visual');
  } catch (err) { toast(explainError(err)); }
  lab.busy = false; refreshView();
}

function results(A, B) {
  const { cmp, va, vb, anA, anB, row, error } = lab.result;
  if (error) return notice('error', 'Could not measure handwriting.', error);
  const canvasA = h('canvas', { class: 'page-canvas', 'aria-label': `Detected writing lines on ${A.displayName}` });
  const canvasB = h('canvas', { class: 'page-canvas', 'aria-label': `Detected writing lines on ${B.displayName}` });
  drawLines(canvasA, A.pages[lab.pageA].gray, va, anA);
  drawLines(canvasB, B.pages[lab.pageB].gray, vb, anB);
  const chartCanvas = h('canvas', { 'aria-label': 'Standardised differences per handwriting feature' });
  queueMicrotask(() => barChart(chartCanvas, {
    labels: cmp.features.map((f) => f.label.replace(/\s*\(.*\)$/, '')),
    datasets: [{ label: 'Standardised difference (z)', data: cmp.features.map((f) => Math.min(f.z, 6)) }],
    xTitle: 'z — under 1 similar, over 2 different', max: 6,
  }));
  const printedWarn = [[A, va], [B, vb]].filter(([d, v]) => d.contentType === 'auto' && !v.handwriting.looksHandwritten);
  return h('section', { class: 'stack' },
    h('div', { class: 'sheet paper-grain' },
      h('div', { class: 'spread' }, h('h2', { text: 'Handwriting-feature comparison' }), stamp(similarityPhrase(row.label), { High: 's-high', Moderate: 's-moderate', Low: 's-low' }[row.label] || 's-neutral')),
      h('p', { text: row.basis }),
      printedWarn.length ? notice('warn', 'Possibly printed text.', `${printedWarn.map(([d]) => d.displayName).join(' and ')} ${printedWarn.length === 1 ? 'does' : 'do'} not show typical handwriting cues. Measurements of printed text describe the typeface, not a writer.`) : null,
      cmp.warnings.length ? notice('warn', 'Measurement limits.', cmp.warnings.join(' ')) : null,
      metricList([
        ['Lines measured', `${va.handwriting.lines} / ${vb.handwriting.lines}`],
        ['Letter shapes', `${va.handwriting.letters} / ${vb.handwriting.letters}`],
        [h('span', {}, 'Stroke-direction similarity'), num(cmp.orientationSimilarity)],
        [h('span', {}, 'Ink texture similarity (LBP)'), num(cmp.textureSimilarity)],
        [h('span', {}, 'Edge-hinge similarity'), num(cmp.hingeSimilarity)],
        [h('span', {}, 'Spacing rhythm (white runs)'), num(cmp.whiteRunSimilarity)],
        ['Combined distance', num(cmp.distance)],
        ['Features similar', `${cmp.features.filter((f) => f.verdict === 'similar').length} of ${cmp.features.length}`],
      ]),
      h('div', { class: 'chart-box tall' }, chartCanvas),
      table({
        caption: 'Feature by feature',
        headers: ['Feature', A.displayName, B.displayName, h('span', {}, term('z-score')), 'Reading'],
        rows: cmp.features.map((f) => [h('span', { title: HANDWRITING_FEATURE_INFO[f.name] }, f.label), num(f.a, 3), num(f.b, 3), num(f.z, 2), stamp(f.verdict)]),
        numeric: [1, 2, 3],
      })),
    h('div', { class: 'grid-2' },
      lineFigure(A, va, anA, canvasA),
      lineFigure(B, vb, anB, canvasB)));
}

function drawLines(canvas, gray, v, an) {
  // Visual profiles are computed on a possibly downscaled, deskewed working copy; draw that copy's line boxes scaled to the page.
  const s = gray.width / v.width;
  const lines = v.lines.map((l) => ({ x0: l.x0 * s, x1: l.x1 * s, y0: l.y0 * s, y1: l.y1 * s }));
  const usable = v.handwriting.perLine.map((p) => ({ x0: p.x0 * s, x1: p.x1 * s, y0: p.y0 * s, y1: p.y1 * s }));
  const flagged = (an.flags || []).map((f) => f.index);
  linesOverlay(canvas, gray, usable.length ? usable : lines, flagged);
}

function lineFigure(d, v, an, canvas) {
  return h('figure', { class: 'sheet aged' },
    h('h3', { text: d.displayName }),
    h('div', { class: 'page-pane' }, canvas),
    h('figcaption', { class: 'fine' },
      `Dashed boxes: the ${v.handwriting.lines} writing lines measured. `,
      an.ok ? (an.flags.length ? `Solid red boxes: ${an.flags.length} line(s) that differ from the rest of this page (${an.flags.map((f) => `line ${f.index + 1}: ${f.features.map((x) => x.description.toLowerCase()).join(', ')}`).join('; ')}).` : 'No line stands out from the rest of the page.') : an.reason,
      v.skewDeg ? ` Page deskewed by ${(-v.skewDeg).toFixed(1)}°.` : '',
      v.handwriting.handwritingCues.length ? ` Handwriting cues: ${v.handwriting.handwritingCues.join(', ')}.` : ''));
}
