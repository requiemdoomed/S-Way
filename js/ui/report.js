/** Analysis reports: the evidence report, exports, session history and the opt-in local archive. */
import { h, mount, pct, num } from '../dom.js';
import { APP, MODULES } from '../config.js';
import { session } from '../core/state.js';
import { exportableReport, featureCsv, buildFindings, moduleName } from '../core/export.js';
import { saveReport, listReports } from '../core/report-store.js';
import { limiter } from '../security/rate-limiter.js';
import { downloadBlob } from '../security/blob-registry.js';
import { pageHeader, emptyState, linkKey, notice, stamp, table, metricList, explainError, toast, similarityPhrase, term } from './common.js';
import { signatureDiff, duplicateFigure } from './render-helpers.js';
import { renderResults as sourceResults } from './source.js';
import { barChart } from './charts.js';
import { refreshView } from './bus.js';

let viewing = null; // id of a report from session history or the archive
let saved = null;

export function renderReports(root) {
  const report = (viewing && (session.history.find((r) => r.id === viewing) || saved?.find((s) => s.report.id === viewing)?.report)) || session.report;
  if (session.settings.saveReports && saved === null) {
    saved = [];
    listReports().then((list) => { saved = list; refreshView(); }).catch(() => { saved = []; });
  }
  if (!report) {
    mount(root, pageHeader('Analysis reports', 'Reports exist only in this tab unless you choose to save them on this device.'),
      emptyState('No report yet. Run an analysis to produce one.', linkKey('#/analysis', 'Start a new analysis')),
      archiveSection());
    return;
  }
  const docs = session.docs;
  const findings = buildFindings(report, docs);
  const name = (id) => report.documents.find((d) => d.id === id)?.name || 'Unknown document';
  const f = report.fusion;

  const sheet = h('article', { class: 'sheet paper-grain printable stack', id: 'report-sheet', 'aria-labelledby': 'rep-title' },
    h('div', { class: 'report-head' },
      h('div', {},
        h('p', { class: 'case-no', text: `Case file ${report.id.toUpperCase()} · ${new Date(report.createdAt).toLocaleString()}` }),
        h('h1', { id: 'rep-title', text: 'Evidence report' }),
        h('p', { class: 'fine', text: `${APP.title} · v${APP.version} · created by ${APP.author}. Automated analytical assistance — completed in ${(report.durationMs / 1000).toFixed(1)} s on this device. Thresholds: ${report.calibration}.` })),
      stamp('Automated analysis', 's-neutral')),
    h('p', { class: 'disclaimer-band', text: report.disclaimer }),
    h('ul', { class: 'report-nav no-print' },
      ['summary', 'matrix', 'conflicts', 'details', 'evidence', 'alternatives'].map((id) => h('li', {}, h('a', { href: `#/reports`, on: { click: (e) => { e.preventDefault(); document.getElementById(`rep-${id}`)?.scrollIntoView({ behavior: 'smooth' }); } } }, { summary: 'Executive summary', matrix: 'Evidence matrix', conflicts: 'Conflicting evidence', details: 'Detailed results', evidence: 'Evidence details', alternatives: 'Alternative explanations' }[id])))),

    // ---------------- executive summary
    h('section', { id: 'rep-summary' },
      h('h2', { text: 'Executive summary' }),
      table({
        caption: 'Documents compared',
        headers: ['Document', 'Type', 'Pages', 'Words', 'Role', 'Text source'],
        rows: report.documents.map((d) => [d.name, d.kind.toUpperCase(), String(d.pages ?? '—'), d.words.toLocaleString(), d.role === 'unassigned' ? '—' : d.role, `${d.engines.join(', ') || '—'}${d.ocrConfidence != null ? ` (OCR ${d.ocrConfidence}%)` : ''}${d.textCorrected ? ' · corrected by user' : ''}`]),
        numeric: [2, 3],
      }),
      docNotes(report),
      h('h3', { text: 'Modules' }),
      h('ul', { class: 'metric-list' }, report.selected.map((m) => {
        const st = f.status[m] || { state: 'not run' };
        return h('li', {}, h('span', { text: MODULES.find((x) => x.id === m)?.label || m }), stamp(st.state));
      })),
      Object.entries(f.status).filter(([, s]) => s.message).map(([m, s]) => h('p', { class: 'fine', text: `${MODULES.find((x) => x.id === m)?.label}: ${s.message}` })),
      h('h3', { text: 'Main findings' }),
      h('ul', {}, f.summary.map((l) => h('li', { text: l }))),
      h('h3', { text: 'Important limitations' }),
      h('ul', {},
        h('li', { text: 'Similarity measures describe likeness, not cause. No result here is a probability of shared authorship.' }),
        [...new Set(f.rows.flatMap((r) => r.reliabilityNotes))].slice(0, 12).map((n) => h('li', { text: n }))),
      h('h3', { text: 'Areas requiring manual review' }),
      reviewList(f, findings)),

    // ---------------- matrix
    h('section', { id: 'rep-matrix' },
      h('h2', { text: 'Evidence matrix' }),
      h('p', { class: 'fine', text: 'Each line of evidence is shown separately. They are never averaged into one score.' }),
      f.rows.length ? table({
        caption: 'Findings by module',
        headers: ['Evidence', 'Documents', 'Finding', 'Basis', 'Reliability'],
        rows: f.rows.map((r) => [r.moduleName, r.pairNames.join(' ↔ '), stamp(['High', 'Moderate', 'Low', 'Inconclusive'].includes(r.label) ? similarityPhrase(r.label) : r.label, labelKind(r.label)), r.basis, r.reliability === 'normal' ? 'Normal' : h('span', {}, r.reliability === 'reduced' ? 'Reduced: ' : 'Insufficient: ', r.reliabilityNotes.join(' '))]),
      }) : notice('info', 'No comparable evidence.', 'None of the selected modules produced a comparison for these documents.')),

    similarityMatrix(report, name),

    // ---------------- conflicts
    h('section', { id: 'rep-conflicts' },
      h('h2', { text: 'Conflicting evidence' }),
      f.conflicts.length ? h('ul', {}, f.conflicts.map((c) => h('li', {}, h('strong', { text: `${c.pairNames.join(' ↔ ')}: ` }), c.description, ' ', c.interpretation)))
        : h('p', { text: 'No strong disagreement between modules was found.' })),

    // ---------------- detail
    h('section', { id: 'rep-details', class: 'stack' },
      h('h2', { text: 'Detailed results' }),
      textDetail(report, name),
      styleDetail(report, name),
      handwritingDetail(report, name),
      signatureDetail(report, name),
      report.results.source && !report.results.source.skipped && !report.results.source.error ? h('div', {}, h('h3', { text: 'Source matching' }), sourceResults(report.results.source, { compact: true })) : null,
      layoutDetail(report, name),
      anomalyDetail(report, name),
      preprocessingDetail(report)),

    // ---------------- evidence
    h('section', { id: 'rep-evidence' },
      h('h2', { text: `Evidence details (${findings.length})` }),
      findings.length ? h('ol', { class: 'stack' }, findings.map((x) => h('li', { class: 'finding' },
        h('p', {}, h('span', { class: 'finding-id', text: x.id }), ` · ${moduleName(x.module)} · ${x.documents.join(' ↔ ')} · ${x.location}`),
        x.excerpt ? h('div', { class: 'excerpt', text: x.excerpt }) : null,
        metricList([['Method', x.method], ['Measurement', x.measurement]]),
        h('p', { class: 'fine' }, h('strong', { text: 'Interpretation: ' }), x.interpretation, ' ', h('strong', { text: 'Limitations: ' }), x.limitations)))) : h('p', { text: 'No individual findings to list.' })),

    // ---------------- alternatives
    h('section', { id: 'rep-alternatives' },
      h('h2', { text: 'Alternative explanations to consider' }),
      Object.entries(f.alternatives).filter(([m]) => report.selected.includes(m)).map(([m, list]) => h('div', {}, h('h3', { text: moduleName(m) }), h('ul', {}, list.map((t) => h('li', { text: t }))))),
      h('p', { class: 'disclaimer-band', text: report.disclaimer })));

  mount(root,
    pageHeader('Analysis reports', 'Every finding below was computed from your documents on this device.'),
    h('div', { class: 'sheet aged no-print' },
      h('h2', { text: 'Export' }),
      h('div', { class: 'button-row' },
        h('button', { type: 'button', class: 'key', on: { click: () => doExport('pdf', report) } }, 'PDF report'),
        h('button', { type: 'button', class: 'key key-quiet', on: { click: () => doExport('json', report) } }, 'JSON data'),
        h('button', { type: 'button', class: 'key key-quiet', on: { click: () => doExport('csv', report) } }, 'CSV feature table'),
        session.settings.saveReports ? h('button', { type: 'button', class: 'key key-quiet', on: { click: async () => { try { await saveReport(exportableReport({ ...report, findings })); saved = null; toast('Report saved on this device (not encrypted).'); refreshView(); } catch (err) { toast(explainError(err)); } } } }, 'Save on this device') : null,
        linkKey('#/compare', 'Open document comparison', true)),
      h('p', { class: 'fine', text: 'The PDF report uses your browser’s print dialog — choose “Save as PDF”. Page-comparison images can be downloaded from the comparison, handwriting and signature labs. Downloads are created in memory; nothing is uploaded.' })),
    sheet,
    historySection(report),
    archiveSection());
}

/** Document × document overview of text and style results (3+ documents). */
function similarityMatrix(report, name) {
  const textPairs = (report.results.text?.pairs || []).filter((p) => p.metrics);
  const ids = [...new Set(textPairs.flatMap((p) => p.pair))];
  if (ids.length < 3) return null;
  const rows = report.fusion.rows.filter((r) => r.module === 'text' || r.module === 'style');
  const cell = (a, b) => {
    if (a === b) return h('td', { class: 'num', text: '—' });
    const p = textPairs.find((x) => (x.pair[0] === a && x.pair[1] === b) || (x.pair[0] === b && x.pair[1] === a));
    if (!p) return h('td', { text: 'not compared' });
    const cov = Math.max(p.metrics.sharedPassageCoverageA, p.metrics.sharedPassageCoverageB);
    const tl = rows.find((r) => r.module === 'text' && r.pair.includes(a) && r.pair.includes(b))?.label || '';
    const sl = rows.find((r) => r.module === 'style' && r.pair.includes(a) && r.pair.includes(b))?.label || '';
    const level = { High: 3, Moderate: 2, Low: cov > 0 ? 1 : 0 }[tl] ?? 0;
    return h('td', { class: 'num', dataset: { level }, title: `Text: ${tl}; style: ${sl}` }, `${pct(cov)} shared`, h('br'), h('small', { text: `text ${tl.toLowerCase()} · style ${sl.toLowerCase() || '—'}` }));
  };
  return h('section', { id: 'rep-heat' },
    h('h2', { text: 'Similarity matrix' }),
    h('p', { class: 'fine', text: 'Share of words inside exact shared passages for every pair, with the text and style labels. Darker cells mark stronger textual overlap; the words in each cell carry the same information.' }),
    h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Similarity matrix', tabindex: '0' },
      h('table', { class: 'ledger heat' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Document' }), ids.map((id) => h('th', { scope: 'col', text: name(id) })))),
        h('tbody', {}, ids.map((a) => h('tr', {}, h('th', { scope: 'row', text: name(a) }), ids.map((b) => cell(a, b))))))));
}

function docNotes(report) {
  const notes = report.documents.flatMap((d) => (d.warnings || []).map((w) => `${d.name}: ${w}`));
  if (!notes.length) return null;
  return h('div', {}, h('h3', { text: 'Notes on the documents' }), h('ul', {}, [...new Set(notes)].slice(0, 30).map((n) => h('li', { text: n }))));
}

function labelKind(label) {
  return { High: 's-high', Moderate: 's-moderate', Low: 's-low', Inconclusive: 's-neutral' }[label];
}

function reviewList(f, findings) {
  const items = [];
  for (const r of f.rows) if (['High', 'Potential match'].includes(r.label) || /to review$/.test(r.label)) items.push(`${r.moduleName} — ${r.pairNames.join(' ↔ ')}: ${r.label}.`);
  for (const c of f.conflicts) items.push(`Disagreement between modules for ${c.pairNames.join(' ↔ ')}.`);
  for (const r of f.rows) if (r.reliability !== 'normal') items.push(`${r.moduleName} — ${r.pairNames.join(' ↔ ')}: reliability ${r.reliability}.`);
  if (!items.length) return h('p', { text: 'Nothing was flagged for priority review. Low similarity does not prove independence either.' });
  return h('ul', {}, [...new Set(items)].slice(0, 25).map((t) => h('li', { text: t })), h('li', { text: `${findings.length} individual findings are listed under Evidence details.` }));
}

function skippedNote(r) {
  if (!r) return null;
  if (r.error) return notice('error', 'Failed.', r.error);
  if (r.skipped) return notice('info', 'Not run.', r.skipped);
  return null;
}

function textDetail(report, name) {
  const r = report.results.text;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', { text: 'Textual similarity' }), skippedNote(r),
    (r.pairs || []).map((p) => p.metrics ? h('div', { class: 'finding' },
      h('h4', { text: `${name(p.pair[0])} ↔ ${name(p.pair[1])}` }),
      p.warnings.map((w) => notice('warn', null, w)),
      metricList([
        ['Identical documents', p.metrics.exactDocument ? 'yes' : 'no'],
        ['Exact paragraphs', String(p.exactParagraphs.length)],
        ['Exact sentences', String(p.counts.exact)],
        ['Near-identical sentences', String(p.counts.near_identical)],
        ['Possible paraphrases', String(p.counts.possible_paraphrase)],
        ['Shared passages (≥ 8 words)', String(p.passages.length)],
        ['Coverage A / B', `${pct(p.metrics.sharedPassageCoverageA)} / ${pct(p.metrics.sharedPassageCoverageB)}`],
        [h('span', {}, '5-', term('n-gram'), ' ', term('containment')), `${pct(p.metrics.ngram5ContainmentAinB)} / ${pct(p.metrics.ngram5ContainmentBinA)}`],
        [h('span', {}, term('TF-IDF'), ' ', term('cosine similarity')), num(p.metrics.tfidfCosine)],
        [h('span', {}, 'Word ', term('Jaccard')), num(p.metrics.tokenJaccard)],
        ['3-gram Jaccard', num(p.metrics.ngram3Jaccard)],
        ['Character-trigram cosine', num(p.metrics.charTrigramCosine)],
        ['Sentence-length similarity', num(p.metrics.sentenceLengthSimilarity)],
        ['Paragraph-length similarity', num(p.metrics.paragraphLengthSimilarity)],
        ['Heading sequence', p.metrics.headingSequenceSimilarity == null ? 'no headings' : num(p.metrics.headingSequenceSimilarity)],
        ['Matched order agreement', p.metrics.matchedOrderAgreement == null ? '—' : pct(p.metrics.matchedOrderAgreement)],
        ['Unique sentences A / B', `${p.uniqueA.length} / ${p.uniqueB.length}`],
      ]),
      h('p', { class: 'fine', text: `Method: ${p.method} Semantic paraphrases that change most of the wording may be missed — no neural embedding model is bundled because S-Way works offline.` })) : null));
}

function styleDetail(report, name) {
  const r = report.results.style;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', {}, 'Writing-style (', term('stylometry'), ')'), skippedNote(r),
    (r.pairs || []).map((p, i) => {
      if (!p.features) return notice('warn', null, p.warnings.join(' '));
      const canvas = h('canvas', { 'aria-label': 'Largest stylometric differences' });
      const top = [...p.features].sort((a, b) => b.z - a.z).slice(0, 14);
      queueMicrotask(() => barChart(canvas, { labels: top.map((f) => f.label), datasets: [{ label: 'Standardised difference (z)', data: top.map((f) => Math.min(f.z, 8)) }], xTitle: 'z — under 1 alike, over 2.5 clearly different', max: 8 }));
      return h('div', { class: 'finding' },
        h('h4', { text: `${name(p.pair[0])} ↔ ${name(p.pair[1])}` }),
        p.warnings.map((w) => notice('warn', null, w)),
        metricList([['Words', `${p.words.a} / ${p.words.b}`], ['Chunks measured', `${p.chunks.a} / ${p.chunks.b}`], ['Features matching', pct(p.agreement)], ['Features clearly different', pct(p.disagreement)], ['Standardised cosine', num(p.cosineStandardized)], ['Standardised distance', num(p.standardizedDistance)]]),
        table({ caption: 'Feature groups', headers: ['Group', 'Match', 'Partial', 'Differ'], rows: p.groups.map((g) => [g.group, String(g.match), String(g.partial), String(g.differs)]), numeric: [1, 2, 3] }),
        h('div', { class: 'chart-box', id: `style-chart-${i}` }, canvas),
        h('p', { class: 'fine', text: `Most alike: ${p.strongestMatches.map((f) => f.label.toLowerCase()).join('; ')}. Most different: ${p.strongestDifferences.map((f) => `${f.label.toLowerCase()} (${num(f.a)} vs ${num(f.b)})`).join('; ')}.` }));
    }),
    r.cluster ? h('div', {}, h('h4', { text: 'Style groups (average-linkage clustering)' }), h('ul', {}, r.cluster.clusters.map((c, i) => h('li', { text: `Group ${i + 1}: ${c.map(name).join(', ')}` }))), h('p', { class: 'fine', text: `Documents are grouped when, on average, fewer than ${pct(r.cluster.threshold)} of their style features clearly differ.` })) : null);
}

function handwritingDetail(report, name) {
  const r = report.results.handwriting;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', { text: 'Handwriting features' }), skippedNote(r),
    (r.pairs || []).map((p) => h('div', { class: 'finding' },
      h('h4', { text: `${name(p.pair[0])} (page ${p.pages[0]}) ↔ ${name(p.pair[1])} (page ${p.pages[1]})` }),
      p.warnings.length ? notice('warn', null, p.warnings.join(' ')) : null,
      table({ caption: 'Handwriting features', headers: ['Feature', 'A', 'B', 'z', 'Reading'], rows: p.features.map((f) => [f.label, num(f.a, 3), num(f.b, 3), num(f.z), stamp(f.verdict)]), numeric: [1, 2, 3] }),
      h('p', { class: 'fine', text: `Combined distance ${num(p.distance ?? p.meanZ)}. Stroke-direction similarity ${num(p.orientationSimilarity)}, ink-texture similarity ${num(p.textureSimilarity)}${p.hingeSimilarity != null ? `, edge-hinge similarity ${num(p.hingeSimilarity)}, spacing-rhythm (white-run) similarity ${num(p.whiteRunSimilarity)}` : ''}. This is a feature comparison, not identification.` }))));
}

function signatureDetail(report, name) {
  const r = report.results.signature;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', { text: 'Signature visual comparison' }), skippedNote(r),
    (r.pairs || []).map((p) => {
      const c = h('canvas', { class: 'page-canvas', 'aria-label': 'Signature difference map' });
      if (p.diffMap) signatureDiff(c, p.diffMap, p.width, p.height);
      return h('div', { class: 'finding' },
        h('h4', { text: `${name(p.pair[0])} ↔ ${name(p.pair[1])}` }),
        p.diffMap ? c : null,
        metricList(Object.entries(p.metrics).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').toLowerCase(), String(v)])),
        h('p', { class: 'fine', text: 'Offline visual comparison only: no pressure, speed or stroke-order information is available from images.' }));
    }));
}

function layoutDetail(report, name) {
  const r = report.results.layout;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', { text: 'Layout and formatting' }), skippedNote(r),
    (r.pairs || []).map((p) => h('div', { class: 'finding' },
      h('h4', { text: `${name(p.pair[0])} ↔ ${name(p.pair[1])}` }),
      table({ caption: 'Layout measurements', headers: ['Measurement', 'A', 'B', 'Reading'], rows: p.features.map((f) => [f.label, num(f.a, 3), num(f.b, 3), stamp(f.verdict)]), numeric: [1, 2] }),
      h('p', { class: 'fine', text: `Alignment: ${p.alignment.join(' / ')}. Identical templates produce identical layouts — this says nothing about authorship.` }))),
    (r.digital || []).map((d) => h('div', { class: 'finding' },
      h('h4', { text: `Digital formatting: ${name(d.pair[0])} ↔ ${name(d.pair[1])}` }),
      metricList([['Font-style overlap', pct(d.fontStyleOverlap)], ['Page numbering', d.pageNumbers.map((x) => (x == null ? 'n/a' : x ? 'yes' : 'no')).join(' / ')], ['Page size', d.pageSize.map((x) => x || 'n/a').join(' / ')]]),
      h('p', { class: 'fine', text: `Main styles A: ${d.stylesA.map((s) => `${s.style} (${pct(s.share)})`).join(', ')}. Main styles B: ${d.stylesB.map((s) => `${s.style} (${pct(s.share)})`).join(', ')}.` }))));
}

function anomalyDetail(report, name) {
  const r = report.results.anomaly;
  if (!r) return null;
  return h('div', { class: 'stack' }, h('h3', {}, 'Anomaly and consistency screening (', term('Isolation Forest'), ', ', term('MAD'), ')'), skippedNote(r),
    (r.documents || []).map((d) => h('div', { class: 'finding' },
      h('h4', { text: name(d.docId) }),
      h('ul', {}, d.checks.map((c) => h('li', { text: `${c.check}: ${c.ok ? `${(c.flags || []).length} flagged` : c.reason || (c.notes || []).join(' ') || 'not applicable'}${c.notes?.length && c.ok ? ` — ${c.notes.join(' ')}` : ''}` }))),
      duplicateFigures(d.docId, d.flags.filter((f) => f.kind === 'duplicate')),
      d.flags.length ? h('ol', {}, d.flags.map((f) => h('li', {},
        h('strong', { text: f.segment || 'Item' }), f.page ? ` (page ${f.page})` : '', ': ',
        f.issue || (f.features || []).map((x) => `${x.description} z ${x.robustZ}`).join('; '),
        f.excerpt ? h('div', { class: 'excerpt', text: f.excerpt }) : null))) : null,
      h('p', { class: 'fine', text: 'Anomalies are leads for review, not evidence of wrongdoing.' }))));
}

function duplicateFigures(docId, flags) {
  if (!flags.length) return null;
  const doc = session.docs.get(docId);
  const pages = [...new Set(flags.map((f) => f.page))];
  return pages.map((page) => {
    const v = (doc?.visual || []).find((x) => x && x.page === page);
    if (!v?.mask) return null;
    const regions = flags.filter((f) => f.page === page).map((f) => ({ source: f.source, copy: f.region }));
    const c = h('canvas', { class: 'page-canvas', 'aria-label': `Duplicated regions on page ${page}` });
    duplicateFigure(c, v, regions);
    return h('figure', { class: 'dup-figure' }, c, h('figcaption', { class: 'fine', text: `Page ${page} (cleaned working copy): dashed brown box = original area, solid red box = its duplicate.` }));
  });
}

function preprocessingDetail(report) {
  const docs = report.documents.filter((d) => d.preprocessing.length);
  if (!docs.length) return null;
  return h('details', { class: 'explain' }, h('summary', {}, 'Image preprocessing applied (working copies only; originals untouched)'),
    docs.map((d) => h('div', {}, h('h4', { text: d.name }), d.preprocessing.map((p) => h('p', { class: 'fine', text: `Page ${p.page}: ${p.operations.join('; ')}. Quality: contrast ${p.quality.contrast}, sharpness ${p.quality.sharpness}${p.quality.issues.length ? ` — ${p.quality.issues.join(', ')}` : ''}.` })))));
}

function historySection(current) {
  const others = session.history.filter((r) => r.id !== current.id);
  if (!others.length) return null;
  return h('section', { class: 'sheet aged no-print' },
    h('h2', { text: 'Earlier reports in this tab' }),
    h('ul', {}, others.map((r) => h('li', {}, h('button', { type: 'button', class: 'link-button', on: { click: () => { viewing = r.id; refreshView(); } } }, `${new Date(r.createdAt).toLocaleTimeString()} — ${r.documents.map((d) => d.name).join(', ')}`)))),
    viewing ? h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { viewing = null; refreshView(); } } }, 'Back to the latest report') : null);
}

function archiveSection() {
  if (!session.settings.saveReports) return null;
  return h('section', { class: 'sheet aged no-print' },
    h('h2', { text: 'Saved on this device' }),
    h('p', { class: 'fine', text: 'Stored in this browser’s IndexedDB because you enabled it in Settings. Not encrypted. Delete them from Settings or the Privacy center.' }),
    saved?.length ? h('ul', {}, saved.map((s) => h('li', {}, h('button', { type: 'button', class: 'link-button', on: { click: () => { viewing = s.report.id; refreshView(); } } }, `${new Date(s.savedAt).toLocaleString()} — ${s.report.documents.map((d) => d.name).join(', ')}`)))) : h('p', { text: 'No saved reports.' }));
}

function doExport(kind, report) {
  try {
    limiter.consume('export');
  } catch (err) { toast(explainError(err)); return; }
  const stampName = `s-way-report-${report.id}`;
  if (kind === 'pdf') { window.print(); return; }
  if (kind === 'json') {
    const data = exportableReport({ ...report, findings: buildFindings(report, session.docs) });
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${stampName}.json`);
  } else {
    downloadBlob(new Blob([featureCsv(report)], { type: 'text/csv;charset=utf-8' }), `${stampName}-features.csv`);
  }
  toast('Export created on this device.');
}
