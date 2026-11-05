/** Signature lab: select signature regions, normalise, align and compare visually. */
import { h, mount, num } from '../dom.js';
import { session, docList, changed } from '../core/state.js';
import { analysisWorker, startAnalysis } from '../core/orchestrator.js';
import { calibration } from '../core/calibration.js';
import { fuseEvidence } from '../core/fusion.js';
import { limiter } from '../security/rate-limiter.js';
import { downloadBlob } from '../security/blob-registry.js';
import { TIMEOUTS } from '../config.js';
import { pageHeader, emptyState, linkKey, docPicker, notice, explainError, toast, stamp, metricList, similarityPhrase, term } from './common.js';
import { grayToCanvas, signatureDiff, canvasToPngDownload, overlayLegend } from './render-helpers.js';
import { refreshView } from './bus.js';

const lab = { a: null, b: null, busy: false, result: null, mode: 'both', key: null };

export function renderSignature(root) {
  const docs = docList().filter((d) => d.validation?.accepted && ['png', 'jpeg', 'webp', 'pdf'].includes(d.kind))
    .sort((x, y) => (y.contentType === 'signature') - (x.contentType === 'signature'));
  const header = pageHeader('Signature lab', 'Select a signature on each document. S-Way crops, normalises and aligns them, then shows where the strokes agree and where they differ.',
    notice('warn', 'Offline, visual comparison only.', 'A photo or scan holds no pen pressure, speed or stroke order — the information dynamic (online) signature verification relies on. Genuine signatures vary, and skilled imitations can look alike, so S-Way never declares a signature authentic or forged.'));
  if (docs.length < 2) {
    mount(root, header, emptyState('Add at least two images or scanned PDFs that contain signatures.', linkKey('#/analysis', 'Add documents')));
    return;
  }
  if (!docs.some((d) => d.id === lab.a)) lab.a = docs[0].id;
  if (!docs.some((d) => d.id === lab.b) || lab.b === lab.a) lab.b = docs.find((d) => d.id !== lab.a).id;
  const A = session.docs.get(lab.a);
  const B = session.docs.get(lab.b);
  const key = `${A.id}|${B.id}|${JSON.stringify(session.signatureRegions.get(A.id) || null)}|${JSON.stringify(session.signatureRegions.get(B.id) || null)}`;
  if (lab.key !== key) lab.result = null;
  const ready = A.scanned && B.scanned && A.pages?.length && B.pages?.length;

  mount(root, header,
    h('section', { class: 'sheet paper-grain stack' },
      h('div', { class: 'grid-2' },
        docPicker('sig-a', docs, lab.a, (v) => { lab.a = v; refreshView(); }, 'First signature'),
        docPicker('sig-b', docs, lab.b, (v) => { lab.b = v; refreshView(); }, 'Second signature')),
      !ready
        ? h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key', disabled: lab.busy ? true : null, on: { click: prepare } }, lab.busy ? 'Preparing…' : 'Prepare pages'))
        : h('div', { class: 'grid-2' }, selector(A), selector(B)),
      ready ? h('div', { class: 'button-row' },
        h('button', { type: 'button', class: 'key', disabled: lab.busy ? true : null, on: { click: () => compare(A, B, key) } }, lab.busy ? 'Comparing…' : 'Compare signatures'),
        h('span', { class: 'fine', text: 'Selections are also used by the signature check in a full analysis.' })) : null),
    lab.result ? results(A, B) : null);
}

async function prepare() {
  try { lab.busy = true; refreshView(); await startAnalysis([], () => {}).promise; } catch (err) { toast(explainError(err)); }
  lab.busy = false; refreshView();
}

/** Region selector: drag on the page preview. Coordinates are stored in working-image pixels. */
function selector(d) {
  const page = d.pages[0];
  const img = h('img', { src: page.preview, alt: `Page 1 of ${d.displayName}` });
  const box = h('div', { class: 'sel-box', hidden: true });
  const wrap = h('div', { class: 'selector', 'aria-label': `Drag to select the signature on ${d.displayName}` }, img, box);
  const region = session.signatureRegions.get(d.id);
  const show = (r) => {
    if (!r) { box.hidden = true; return; }
    const s = img.clientWidth / page.width;
    box.hidden = false;
    box.style.left = `${r.x * s}px`; box.style.top = `${r.y * s}px`;
    box.style.width = `${r.w * s}px`; box.style.height = `${r.h * s}px`;
  };
  img.addEventListener('load', () => show(region));
  let start = null;
  wrap.addEventListener('pointerdown', (e) => {
    const rect = img.getBoundingClientRect();
    start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!start) return;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const s = page.width / rect.width;
    show({ x: Math.min(x, start.x) * s, y: Math.min(y, start.y) * s, w: Math.abs(x - start.x) * s, h: Math.abs(y - start.y) * s });
  });
  wrap.addEventListener('pointerup', (e) => {
    if (!start) return;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const s = page.width / rect.width;
    const r = { x: Math.round(Math.min(x, start.x) * s), y: Math.round(Math.min(y, start.y) * s), w: Math.round(Math.abs(x - start.x) * s), h: Math.round(Math.abs(y - start.y) * s) };
    start = null;
    if (r.w > 15 && r.h > 10) { session.signatureRegions.set(d.id, r); changed('signature'); refreshView(); }
  });

  const suggestion = async () => {
    try {
      d.visual ||= [];
      if (!d.visual[0]) { const v = await analysisWorker.call('visualProfile', { gray: page.gray, wantHandwriting: false }); v.page = page.index; d.visual[0] = v; }
      const sg = d.visual[0].signatureSuggestion;
      if (!sg) { toast('No likely signature area was found. Drag a box around it instead.'); return; }
      const s = page.width / d.visual[0].width;
      session.signatureRegions.set(d.id, { x: Math.round(sg.x * s), y: Math.round(sg.y * s), w: Math.round(sg.w * s), h: Math.round(sg.h * s) });
      changed('signature');
      toast(`Suggested region selected (${sg.basis}). Check it before comparing.`);
      refreshView();
    } catch (err) { toast(explainError(err)); }
  };

  return h('div', { class: 'stack' },
    h('h3', { text: d.displayName }),
    wrap,
    h('p', { class: 'fine', text: region ? `Selected region: ${region.w} × ${region.h} px at (${region.x}, ${region.y}).` : 'No region selected — the whole image will be used.' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: suggestion } }, 'Suggest region'),
      h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { session.signatureRegions.delete(d.id); changed('signature'); refreshView(); } } }, 'Use whole image')));
}

async function compare(A, B, key) {
  try {
    limiter.consume('ml');
    lab.busy = true; refreshView();
    const r = await analysisWorker.call('signature', { a: A.pages[0].gray, b: B.pages[0].gray, regionA: session.signatureRegions.get(A.id) || null, regionB: session.signatureRegions.get(B.id) || null }, { timeoutMs: TIMEOUTS.signatureMs, label: 'Signature comparison' });
    if (!r.ok) lab.result = { error: r.warnings.join(' ') };
    else {
      const fused = fuseEvidence({ signature: { pairs: [{ ...r, pair: [A.id, B.id] }] } }, session.docs, ['signature'], calibration.fusion);
      lab.result = { r, row: fused.rows[0] };
    }
    lab.key = key;
  } catch (err) { toast(explainError(err)); }
  lab.busy = false; refreshView();
}

function results(A, B) {
  if (lab.result.error) return notice('error', 'No signature found.', lab.result.error);
  const { r, row } = lab.result;
  const m = r.metrics;
  const ca = grayToCanvas(r.imageA, h('canvas', { class: 'page-canvas', 'aria-label': `Normalised signature from ${A.displayName}` }));
  const cb = grayToCanvas(r.imageB, h('canvas', { class: 'page-canvas', 'aria-label': `Normalised signature from ${B.displayName}` }));
  const cd = h('canvas', { class: 'page-canvas', 'aria-label': 'Difference map of the aligned signatures' });
  signatureDiff(cd, r.diffMap, r.width, r.height, lab.mode);
  return h('section', { class: 'sheet paper-grain stack' },
    h('div', { class: 'spread' }, h('h2', { text: 'Signature visual comparison' }), stamp(similarityPhrase(row.label), { High: 's-high', Moderate: 's-moderate', Low: 's-low' }[row.label])),
    h('p', { text: row.basis }),
    r.warnings.length ? notice('warn', 'Image quality.', r.warnings.join(' ')) : null,
    h('div', { class: 'sig-figs' },
      h('figure', {}, ca, h('figcaption', { text: `${A.displayName} — normalised` })),
      h('figure', {}, cb, h('figcaption', { text: `${B.displayName} — normalised` })),
      h('figure', {}, cd, h('figcaption', { text: `Aligned overlay (second rotated ${r.alignment.rotationDeg}°, shifted ${r.alignment.shiftX}, ${r.alignment.shiftY} px)` }))),
    h('div', { class: 'row' }, ['both', 'a', 'b'].map((mode) => h('button', { type: 'button', class: `key key-small${lab.mode === mode ? '' : ' key-quiet'}`, 'aria-pressed': String(lab.mode === mode), on: { click: () => { lab.mode = mode; refreshView(); } } }, mode === 'both' ? 'Show both' : mode === 'a' ? 'First only' : 'Second only')),
      h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { try { limiter.consume('export'); canvasToPngDownload(cd, 's-way-signature-overlay.png', downloadBlob); } catch (err) { toast(explainError(err)); } } } }, 'Download overlay')),
    overlayLegend(A.displayName, B.displayName),
    metricList([
      [h('span', {}, 'Tolerant overlap'), num(m.tolerantOverlap)],
      [h('span', {}, term('chamfer distance'), ' (px)'), num(m.chamferDistancePx, 1)],
      [h('span', {}, term('SSIM')), num(m.ssim)],
      ['Shape-moment distance', num(m.shapeMomentDistance)],
      ['Row-profile correlation', num(m.horizontalProfileCorrelation)],
      ['Column-profile correlation', num(m.verticalProfileCorrelation)],
      ['Stroke-direction similarity', num(m.strokeDirectionSimilarity)],
      ['Aspect ratio', `${num(m.aspectRatioA)} / ${num(m.aspectRatioB)}`],
      ['Separate strokes', `${m.strokeCountA} / ${m.strokeCountB}`],
      ['Ink only in first / second', `${Math.round(m.inkOnlyInA * 100)}% / ${Math.round(m.inkOnlyInB * 100)}%`],
    ]),
    r.missingOrExtra.length ? h('div', {}, h('h3', { text: 'Regions present in only one signature' }),
      h('ul', {}, r.missingOrExtra.map((x) => h('li', { text: `${x.where}: ${x.position} area, about ${x.w} × ${x.h} px (normalised scale)` })))) : h('p', { text: 'No substantial stroke region appears in only one signature after alignment.' }));
}
