/**
 * Research notebooks viewer: renders the executed Jupyter notebooks shipped with S-Way
 * (notebooks/*.ipynb) directly inside the app, so the methods and evidence behind every
 * threshold can be read without installing Jupyter.
 *
 * Safety: notebooks are fetched from this site only. Markdown is rendered by a small
 * DOM-based renderer (no innerHTML); HTML outputs are NEVER rendered — the plain-text
 * representation is shown instead; only base64 PNG images are displayed.
 */
import { h, mount } from '../dom.js';
import { pageHeader, notice, linkKey } from './common.js';
import { refreshView } from './bus.js';

const state = { index: null, error: null, open: null, cache: new Map(), loading: false, showCode: false };

async function loadIndex() {
  try {
    const r = await fetch('notebooks/index.json', { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw new Error();
    state.index = await r.json();
  } catch {
    state.error = 'The notebook index could not be loaded. If you opened S-Way from a host that does not publish the notebooks folder, the notebooks are still in the repository under notebooks/.';
  }
  refreshView();
}

async function loadNotebook(file) {
  if (!/^[0-9]{2}_[a-z0-9_]+\.ipynb$/.test(file)) return; // only listed, well-formed names
  state.loading = true;
  refreshView();
  try {
    const r = await fetch(`notebooks/${file}`, { credentials: 'omit' });
    if (!r.ok) throw new Error();
    const nb = await r.json();
    state.cache.set(file, nb);
  } catch {
    state.error = `The notebook ${file} could not be loaded.`;
  }
  state.loading = false;
  refreshView();
}

export function renderResearch(root, arg) {
  if (!state.index && !state.error) loadIndex();
  if (arg && state.index?.notebooks?.some((n) => n.file === arg)) state.open = arg;
  const header = pageHeader('Research notebooks', 'The executed Jupyter experiments behind S-Way’s methods and thresholds — read them here, or run them yourself.',
    h('p', { class: 'fine', text: 'Every figure below was produced by running the notebook against the same JavaScript engines this app uses. Text data is public domain; all images are synthetic.' }));
  if (state.error && !state.index) { mount(root, header, notice('warn', 'Not available.', state.error)); return; }
  if (!state.index) { mount(root, header, h('p', { text: 'Loading the notebook index…' })); return; }

  const list = h('section', { class: 'pinboard', 'aria-label': 'Notebooks' }, state.index.notebooks.map((n) => h('a', {
    class: `note paper-grain${state.open === n.file ? ' current' : ''}`,
    href: `#/research/${n.file}`,
    'aria-current': state.open === n.file ? 'true' : null,
  }, h('h3', { text: n.title }), h('p', { text: n.summary }))));

  let body = null;
  if (state.open) {
    const nb = state.cache.get(state.open);
    if (!nb && !state.loading) loadNotebook(state.open);
    body = nb ? renderNotebook(nb, state.open) : h('p', { text: 'Loading notebook…' });
  }

  mount(root, header,
    h('section', { class: 'sheet aged paper-grain' },
      h('h2', { text: 'Run them yourself' }),
      h('ol', {},
        h('li', {}, 'Install Python 3.11+, Node 20+ and the Tesseract 5 binary.'),
        h('li', {}, h('code', { text: 'pip install -r requirements.txt' })),
        h('li', {}, h('code', { text: 'python3 tools/build_notebooks.py' }), ' — rebuilds and executes all notebooks (about 6 minutes) and rewrites models/calibration.json.'),
        h('li', {}, 'Or explore interactively: ', h('code', { text: 'jupyter notebook notebooks/' }), '.')),
      state.index.generated ? h('p', { class: 'fine', text: `Notebooks last executed: ${state.index.generated}.` }) : null),
    list,
    body);
}

function renderNotebook(nb, file) {
  const meta = state.index.notebooks.find((n) => n.file === file);
  const cells = (nb.cells || []).slice(0, 400);
  return h('article', { class: 'sheet paper-grain notebook', 'aria-label': meta?.title || file },
    h('div', { class: 'spread no-print' },
      h('p', { class: 'case-no', text: file }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.showCode ? true : null, on: { change: (e) => { state.showCode = e.target.checked; refreshView(); } } }),
        h('span', {}, 'Show code cells'))),
    cells.map((c) => renderCell(c)),
    h('div', { class: 'button-row' }, linkKey('#/research', 'Back to all notebooks', true)));
}

const text = (v) => (Array.isArray(v) ? v.join('') : String(v ?? ''));

function renderCell(c) {
  if (c.cell_type === 'markdown') return h('div', { class: 'nb-md' }, markdown(text(c.source)));
  if (c.cell_type !== 'code') return null;
  const outputs = (c.outputs || []).map(renderOutput).filter(Boolean);
  const code = h('details', { class: 'nb-code', open: state.showCode ? true : null }, h('summary', {}, 'Code'), h('pre', {}, h('code', { text: text(c.source) })));
  return h('div', { class: 'nb-cell' }, code, outputs.length ? h('div', { class: 'nb-out' }, outputs) : null);
}

function renderOutput(o) {
  if (o.output_type === 'stream') {
    if (o.name === 'stderr') return null;
    return h('pre', { class: 'nb-text', text: text(o.text).slice(0, 20000) });
  }
  if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
    const d = o.data || {};
    const png = text(d['image/png']).replace(/\s+/g, '');
    if (png && /^[A-Za-z0-9+/=]+$/.test(png)) return h('img', { class: 'nb-img', src: `data:image/png;base64,${png}`, alt: 'Notebook figure', loading: 'lazy' });
    if (d['text/plain']) {
      const t = text(d['text/plain']);
      if (/^<Figure size/.test(t)) return null;
      return h('pre', { class: 'nb-text', text: t.slice(0, 20000) });
    }
  }
  if (o.output_type === 'error') return h('pre', { class: 'nb-text nb-err', text: `${o.ename}: ${o.evalue}` });
  return null;
}

// ------------------------------------------------------------------ minimal, safe Markdown
/** Render a Markdown subset (headings, paragraphs, lists, tables, emphasis, code, relative links) as DOM. */
export function markdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { out.push(h(`h${Math.min(hm[1].length + 1, 4)}`, {}, inline(hm[2]))); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      const head = cells(rows[0]);
      out.push(h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, inline(x))))),
        h('tbody', {}, rows.slice(2).map((r) => h('tr', {}, cells(r).map((x) => h('td', {}, inline(x)))))))));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      out.push(h(ordered ? 'ol' : 'ul', {}, items.map((t) => h('li', {}, inline(t)))));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*\||^\s*([-*]|\d+\.)\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(h('p', {}, inline(para.join(' '))));
  }
  return out;
}

function inline(s) {
  const nodes = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) nodes.push(h('code', { text: t.slice(1, -1) }));
    else if (m[2]) nodes.push(h('strong', { text: t.slice(2, -2) }));
    else if (m[3]) nodes.push(h('em', { text: t.slice(1, -1) }));
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      // Only same-site relative links; anything else is shown as plain text.
      nodes.push(/^(#|[a-z0-9_./-]+$)/i.test(href) && !/^\/\//.test(href) && !/^[a-z]+:/i.test(href) ? h('a', { href }, label) : `${label} (${href})`);
    }
    last = m.index + t.length;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}
