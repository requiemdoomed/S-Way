/** Source investigation: match examined documents against user-supplied source material. */
import { h, mount, pct } from '../dom.js';
import { session, docList, effectiveText, changed } from '../core/state.js';
import { analysisWorker, startAnalysis, wordsOf } from '../core/orchestrator.js';
import { calibration } from '../core/calibration.js';
import { limiter } from '../security/rate-limiter.js';
import { ROLES } from '../config.js';
import { pageHeader, emptyState, linkKey, notice, explainError, toast, table, stamp, select } from './common.js';
import { refreshView } from './bus.js';

const lab = { busy: false, result: null };

export function renderSource(root) {
  const docs = docList().filter((d) => d.validation?.accepted && d.contentType !== 'signature');
  const header = pageHeader('Source investigation', 'Mark the documents that are possible sources, then trace which passages of the other documents match them.',
    notice('info', 'Scope.', 'Only documents you supply in this session are searched. S-Way does not search the internet or any external database, and it never invents sources or links.'));
  if (docs.length < 2) {
    mount(root, header, emptyState('Add at least two text documents: one or more sources and something to examine.', linkKey('#/analysis', 'Add documents')));
    return;
  }
  const sources = docs.filter((d) => d.role === 'source' || d.role === 'reference');
  const result = lab.result || session.report?.results?.source;

  mount(root, header,
    h('section', { class: 'sheet paper-grain stack' },
      h('h2', { text: 'Assign sources' }),
      table({
        caption: 'Documents in this session',
        headers: ['Document', 'Words', 'Role'],
        rows: docs.map((d) => [d.displayName, d.scanned ? wordsOf(d).toLocaleString() : 'not extracted yet', select(`src-role-${d.id}`, ROLES, d.role, (v) => { d.role = v; lab.result = null; changed('docs'); refreshView(); }, `Role of ${d.displayName}`)]),
        numeric: [1],
      }),
      !sources.length ? notice('warn', 'No sources marked.', 'Set at least one document’s role to “Source material” or “Reference document”.') : null,
      h('div', { class: 'button-row' },
        h('button', { type: 'button', class: 'key', disabled: !sources.length || lab.busy ? true : null, on: { click: () => investigate(docs) } }, lab.busy ? 'Investigating…' : 'Investigate sources'))),
    result && !result.skipped && !result.error ? renderResults(result) : null,
    result?.skipped ? notice('info', 'Not run.', result.skipped) : null);
}

async function investigate(docs) {
  try {
    limiter.consume('analysis');
    lab.busy = true; refreshView();
    if (docs.some((d) => !d.scanned)) await startAnalysis([], () => {}).promise;
    const ready = docList().filter((d) => d.validation?.accepted && d.scanned && wordsOf(d) > 0 && d.contentType !== 'signature');
    const td = (d) => ({ id: d.id, name: d.displayName, text: effectiveText(d), pageStarts: d.pageStarts || [0] });
    const sources = ready.filter((d) => d.role === 'source' || d.role === 'reference');
    const examined = ready.filter((d) => !sources.includes(d));
    if (!sources.length || !examined.length) throw new Error('At least one source and one other document with text are needed.');
    lab.result = await analysisWorker.call('source', { examined: examined.map(td), sources: sources.map(td), thresholds: calibration.text }, { label: 'Source investigation' });
  } catch (err) { toast(explainError(err)); }
  lab.busy = false; refreshView();
}

export function renderResults(result, { compact = false } = {}) {
  return h('section', { class: 'stack' },
    h('p', { class: 'fine', text: result.scope }),
    result.results.map((res) => {
      const ex = session.docs.get(res.examinedId);
      const text = ex ? effectiveText(ex) : '';
      const label = res.combinedCoverage >= calibration.fusion.source.potentialCoverage ? 'Potential match' : res.sources.some((s) => s.matchCount) ? 'Limited overlap' : 'No match found';
      return h('article', { class: 'sheet paper-grain stack' },
        h('div', { class: 'spread' }, h('h3', { text: `Examined: ${res.examinedName}` }), stamp(label)),
        h('p', { text: `${pct(res.combinedCoverage)} of its ${res.words.toLocaleString()} words lie inside exact or near-identical matches with the sources below.` }),
        table({
          caption: 'Sources ranked by shared-passage coverage',
          headers: ['Source', 'Shared-passage coverage', 'Possible paraphrases', 'Order agreement', 'Matches'],
          rows: res.sources.map((s) => [s.sourceName, pct(s.sharedPassageCoverage), pct(s.paraphraseRate), s.orderAgreement == null ? '—' : pct(s.orderAgreement), String(s.matchCount)]),
          numeric: [1, 2, 3, 4],
        }),
        compact ? null : res.sources.filter((s) => s.matchCount).map((s) => h('details', { class: 'explain' },
          h('summary', {}, `${s.matchCount} match${s.matchCount === 1 ? '' : 'es'} with ${s.sourceName}`),
          h('ol', {}, s.matches.slice(0, 60).map((m) => {
            const src = session.docs.get(s.sourceId);
            const srcText = src ? effectiveText(src) : '';
            return h('li', { class: 'finding' },
              h('p', { class: 'fine', text: `${m.method} · score ${m.score.toFixed(2)} · examined page ${m.examined.page}${m.examined.paragraph ? `, paragraph ${m.examined.paragraph}` : ''} → source page ${m.source.page}${m.source.paragraph ? `, paragraph ${m.source.paragraph}` : ''}` }),
              h('div', { class: 'excerpt' }, h('mark', { class: m.method.startsWith('Exact') ? 'm-exact' : m.method.startsWith('Near') ? 'm-near' : 'm-para', text: text.slice(m.examined.start, m.examined.end).slice(0, 700) })),
              h('div', { class: 'excerpt', text: `Source: ${srcText.slice(m.source.start, m.source.end).slice(0, 700)}` }));
          })))));
    }));
}
