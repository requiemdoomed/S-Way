/** Document comparison workspace: split-screen text with highlights, pages with overlays, text correction. */
import { h, mount, clear, pct } from '../dom.js';
import { session, docList, effectiveText, changed } from '../core/state.js';
import { analysisWorker, bestVisual, wordsOf } from '../core/orchestrator.js';
import { calibration } from '../core/calibration.js';
import { limiter } from '../security/rate-limiter.js';
import { downloadBlob } from '../security/blob-registry.js';
import { UPLOAD_LIMITS } from '../config.js';
import { cleanExtractedText } from '../security/sanitize.js';
import { pageHeader, emptyState, linkKey, docPicker, notice, explainError, toast, metricList, term } from './common.js';
import { highlightedText, maskOverlay, overlayLegend, canvasToPngDownload } from './render-helpers.js';
import { refreshView } from './bus.js';

const view = { a: null, b: null, tab: 'text', pageA: 0, pageB: 0, zoom: 1, overlayMode: 'both', editId: null, computing: false };

export function renderCompare(root, arg) {
  const docs = docList().filter((d) => d.validation?.accepted);
  if (arg && session.docs.has(arg)) { view.tab = 'edit'; view.editId = arg; }
  if (!docs.length) {
    mount(root, pageHeader('Document comparison', 'Side-by-side text and page images with every match marked.'),
      emptyState('No documents in this session yet.', linkKey('#/analysis', 'Add documents')));
    return;
  }
  if (!session.docs.has(view.a)) view.a = docs[0]?.id;
  if (!session.docs.has(view.b) || view.b === view.a) view.b = docs.find((d) => d.id !== view.a)?.id || view.a;
  if (!session.docs.has(view.editId)) view.editId = docs[0].id;

  const tabs = [['text', 'Text side by side'], ['pages', 'Pages side by side'], ['edit', 'Review & correct text']];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(view.tab === id), on: { click: () => { view.tab = id; refreshView(); } },
  }, label)));

  let body;
  if (view.tab === 'edit') body = editPanel(docs);
  else if (docs.length < 2) body = notice('warn', 'Only one document.', 'Add a second document to compare side by side. You can still review and correct this document’s text.');
  else body = view.tab === 'text' ? textPanel(docs) : pagesPanel(docs);

  mount(root,
    pageHeader('Document comparison', 'Choose two documents. Matching passages are marked in both; select a mark to jump to its partner.'),
    h('section', { class: 'sheet paper-grain' }, tabBar,
      view.tab !== 'edit' && docs.length >= 2 ? h('div', { class: 'grid-2' },
        docPicker('cmp-a', docs, view.a, (v) => { view.a = v; view.pageA = 0; refreshView(); }, 'Left document'),
        docPicker('cmp-b', docs, view.b, (v) => { view.b = v; view.pageB = 0; refreshView(); }, 'Right document')) : null,
      body));
}

// ------------------------------------------------------------ text
function findTextResult(a, b) {
  const pairs = session.report?.results?.text?.pairs || [];
  const direct = pairs.find((p) => p.pair[0] === a && p.pair[1] === b);
  if (direct) return { r: direct, flipped: false };
  const rev = pairs.find((p) => p.pair[0] === b && p.pair[1] === a);
  return rev ? { r: rev, flipped: true } : null;
}
const onDemand = new Map();

function textPanel() {
  const A = session.docs.get(view.a);
  const B = session.docs.get(view.b);
  if (!A.scanned || !B.scanned) return notice('warn', 'Text not extracted yet.', 'Run an analysis (or “Extract text only”) on the New analysis page first.', ' ', h('a', { href: '#/analysis' }, 'Go to New analysis'));
  const key = `${A.id}|${B.id}|${A.text.corrected ? 1 : 0}${B.text.corrected ? 1 : 0}`;
  const found = findTextResult(A.id, B.id) || (onDemand.has(key) ? { r: onDemand.get(key), flipped: false } : null);
  if (!found) {
    return h('div', { class: 'stack' },
      notice('info', 'Not compared yet.', 'These two documents have not been compared in the current report.'),
      h('button', { type: 'button', class: 'key', disabled: view.computing ? true : null, on: { click: async () => {
        try {
          limiter.consume('analysis');
          view.computing = true; refreshView();
          const r = await analysisWorker.call('text', { a: { id: A.id, text: effectiveText(A) }, b: { id: B.id, text: effectiveText(B) }, thresholds: calibration.text });
          onDemand.set(key, r);
        } catch (err) { toast(explainError(err)); }
        view.computing = false; refreshView();
      } } }, view.computing ? 'Comparing…' : 'Compare these two texts'));
  }
  const { r, flipped } = found;
  const side = (x) => (flipped ? (x === 'a' ? 'b' : 'a') : x);
  const rangesFor = (which) => {
    const s = side(which);
    const out = [];
    r.passages.forEach((p, i) => out.push({ start: p[s].start, end: p[s].end, cls: 'm-exact', id: `p${i}`, title: `Exact shared passage (${p.words} words)` }));
    r.sentenceMatches.forEach((m, i) => {
      if (m.category === 'exact') return;
      out.push({ start: m[s].start, end: m[s].end, cls: m.category === 'near_identical' ? 'm-near' : 'm-para', id: `s${i}`, title: `${m.category === 'near_identical' ? 'Near-identical' : 'Possible paraphrase'} — character similarity ${pct(m.charScore)}` });
    });
    return out;
  };
  const paneA = h('div', { class: 'text-pane', tabindex: '0', 'aria-label': `Text of ${A.displayName}` });
  const paneB = h('div', { class: 'text-pane', tabindex: '0', 'aria-label': `Text of ${B.displayName}` });
  const jump = (id, from) => {
    for (const m of document.querySelectorAll('mark.active')) m.classList.remove('active');
    const other = (from.closest('.text-pane') === paneA ? paneB : paneA).querySelector(`mark[data-match="${CSS.escape(id)}"]`);
    from.classList.add('active');
    if (other) { other.classList.add('active'); other.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  };
  paneA.append(highlightedText(effectiveText(A), rangesFor('a'), jump));
  paneB.append(highlightedText(effectiveText(B), rangesFor('b'), jump));
  const m = r.metrics;
  return h('div', { class: 'stack' },
    h('ul', { class: 'legend' },
      h('li', {}, h('mark', { class: 'm-exact', text: 'solid underline' }), ' exact shared passage'),
      h('li', {}, h('mark', { class: 'm-near', text: 'dashed underline' }), ' near-identical sentence'),
      h('li', {}, h('mark', { class: 'm-para', text: 'dotted underline' }), ' possible paraphrase')),
    metricList([
      ['Shared passages', String(r.passages.length)],
      [`Coverage (left)`, pct(flipped ? m.sharedPassageCoverageB : m.sharedPassageCoverageA)],
      ['Coverage (right)', pct(flipped ? m.sharedPassageCoverageA : m.sharedPassageCoverageB)],
      ['TF-IDF cosine', m.tfidfCosine.toFixed(2)],
      ['Paraphrase candidates', String(r.counts.possible_paraphrase)],
    ]),
    h('div', { class: 'split' },
      h('div', { class: 'split-pane' }, h('h3', { text: A.displayName }), paneA),
      h('div', { class: 'split-pane' }, h('h3', { text: B.displayName }), paneB)),
    h('p', { class: 'fine', text: 'Highlights show where wording overlaps. Quotations, shared sources and set phrases also overlap — read the context.' }));
}

// ------------------------------------------------------------ pages
function pagesPanel() {
  const A = session.docs.get(view.a);
  const B = session.docs.get(view.b);
  const pa = A.pages || [];
  const pb = B.pages || [];
  if (!pa.length || !pb.length) {
    return notice('info', 'No page images.', A.scanned && B.scanned ? 'DOCX and TXT files have no page images. Choose PDFs or images to compare pages.' : 'Run an analysis or “Extract text only” first so pages are rendered.');
  }
  view.pageA = Math.min(view.pageA, pa.length - 1);
  view.pageB = Math.min(view.pageB, pb.length - 1);
  const pager = (pages, key, label) => h('div', { class: 'pager' },
    h('button', { type: 'button', class: 'key key-quiet key-small', disabled: view[key] === 0 ? true : null, 'aria-label': `Previous page of ${label}`, on: { click: () => { view[key]--; refreshView(); } } }, 'Previous'),
    h('span', { text: `Page ${pages[view[key]].index} (${view[key] + 1} of ${pages.length} rendered)` }),
    h('button', { type: 'button', class: 'key key-quiet key-small', disabled: view[key] >= pages.length - 1 ? true : null, 'aria-label': `Next page of ${label}`, on: { click: () => { view[key]++; refreshView(); } } }, 'Next'));
  const img = (p, name) => {
    const el = h('img', { src: p.preview, alt: `Page ${p.index} of ${name}` });
    el.style.width = `${Math.round(view.zoom * 100)}%`;
    return el;
  };
  const zoom = h('div', { class: 'pager' },
    h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { view.zoom = Math.max(0.5, view.zoom - 0.25); refreshView(); } } }, 'Zoom out'),
    h('span', { text: `${Math.round(view.zoom * 100)}%` }),
    h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { view.zoom = Math.min(3, view.zoom + 0.25); refreshView(); } } }, 'Zoom in'));

  const overlayBox = h('div', { class: 'stack' });
  const va = A.visual?.[view.pageA];
  const vb = B.visual?.[view.pageB];
  if (va && vb) {
    const canvas = h('canvas', { class: 'page-canvas', 'aria-label': 'Overlay of both pages aligned at their text areas' });
    const share = maskOverlay(canvas, va, vb, view.overlayMode);
    overlayBox.append(
      h('h3', { text: 'Overlay' }),
      h('div', { class: 'row' }, ['both', 'a', 'b'].map((m) => h('button', { type: 'button', class: `key key-small${view.overlayMode === m ? '' : ' key-quiet'}`, 'aria-pressed': String(view.overlayMode === m), on: { click: () => { view.overlayMode = m; refreshView(); } } }, m === 'both' ? 'Both' : m === 'a' ? 'Left only' : 'Right only'))),
      overlayLegend(A.displayName, B.displayName),
      h('p', { class: 'fine', text: `Pages aligned at the top-left of their text areas. Ink only on the left: ${pct(share.onlyA)}; only on the right: ${pct(share.onlyB)}; overlapping: ${pct(share.both)}. Different texts never overlap well — the overlay is most useful for pages that should be identical, such as two copies of a form.` }),
      h('div', { class: 'page-pane' }, canvas),
      h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { try { limiter.consume('export'); canvasToPngDownload(canvas, `s-way-overlay.png`, downloadBlob); } catch (err) { toast(explainError(err)); } } } }, 'Download overlay image'));
  } else {
    overlayBox.append(h('button', { type: 'button', class: 'key key-quiet', disabled: view.computing ? true : null, on: { click: async () => {
      try {
        limiter.consume('ml');
        view.computing = true; refreshView();
        for (const [d, i] of [[A, view.pageA], [B, view.pageB]]) {
          d.visual ||= [];
          if (!d.visual[i]) { const r = await analysisWorker.call('visualProfile', { gray: d.pages[i].gray, wantHandwriting: false }); r.page = d.pages[i].index; d.visual[i] = r; }
        }
      } catch (err) { toast(explainError(err)); }
      view.computing = false; refreshView();
    } } }, view.computing ? 'Building overlay…' : 'Build an overlay of these two pages'));
  }

  return h('div', { class: 'stack' }, zoom,
    h('div', { class: 'split' },
      h('div', { class: 'split-pane' }, h('h3', { text: A.displayName }), pager(pa, 'pageA', A.displayName), h('div', { class: 'page-pane' }, img(pa[view.pageA], A.displayName))),
      h('div', { class: 'split-pane' }, h('h3', { text: B.displayName }), pager(pb, 'pageB', B.displayName), h('div', { class: 'page-pane' }, img(pb[view.pageB], B.displayName)))),
    (A.pageCount > pa.length || B.pageCount > pb.length) ? h('p', { class: 'fine', text: 'Only the first pages of long PDFs are rendered as images for visual analysis; text from every page is still extracted.' }) : null,
    overlayBox);
}

// ------------------------------------------------------------ text correction
function editPanel(docs) {
  const d = session.docs.get(view.editId);
  const picker = docPicker('edit-doc', docs, d.id, (v) => { view.editId = v; refreshView(); }, 'Document');
  if (!d.scanned) return h('div', { class: 'stack' }, picker, notice('info', 'Text not extracted yet.', 'Run an analysis or “Extract text only” first.'));
  const area = h('textarea', { id: 'edit-text', spellcheck: 'false', 'aria-describedby': 'edit-help' });
  area.value = effectiveText(d);
  const conf = d.extraction?.ocrConfidence;
  const showOrig = h('details', { class: 'explain' }, h('summary', {}, 'Show the original extracted text (kept unchanged)'), h('div', { class: 'text-pane', text: d.text.original }));
  return h('div', { class: 'stack' },
    picker,
    metricList([
      ['Extraction', (d.extraction?.engine || []).join(', ') || '—'],
      ['Words', wordsOf(d).toLocaleString()],
      [h('span', {}, term('OCR confidence')), Number.isFinite(conf) ? `${conf}%` : 'not applicable'],
      ['Status', d.text.corrected != null ? 'Corrected by you' : 'Original extraction'],
    ]),
    Number.isFinite(conf) && conf < 70 ? notice('warn', 'Low OCR confidence.', 'Machine-read text from this document is unreliable. Correct it before relying on text or style results.') : null,
    d.contentType === 'handwritten' ? notice('warn', 'Handwriting OCR.', 'The OCR engine is trained on print, so text read from handwriting is often wrong. Typing a correction gives far better text results.') : null,
    h('label', { for: 'edit-text', text: `Text of ${d.displayName}` }),
    area,
    h('p', { id: 'edit-help', class: 'fine', text: 'Corrections are used by every text, style and source check. The original extraction is preserved separately and can be restored.' }),
    h('div', { class: 'button-row' },
      h('button', { type: 'button', class: 'key', on: { click: () => {
        const next = cleanExtractedText(area.value, UPLOAD_LIMITS.maxExtractedChars);
        d.text.corrected = next === d.text.original ? null : next;
        onDemand.clear();
        changed('docs');
        toast(d.text.corrected != null ? 'Correction saved. Run the analysis again to update the report.' : 'No changes from the original.');
        refreshView();
      } } }, 'Save correction'),
      h('button', { type: 'button', class: 'key key-quiet', disabled: d.text.corrected == null ? true : null, on: { click: () => { d.text.corrected = null; onDemand.clear(); changed('docs'); toast('Original text restored.'); refreshView(); } } }, 'Restore original')),
    showOrig);
}
