/**
 * Shared UI building blocks. All untrusted strings go through h()/textContent.
 */
import { h, mount, announce } from '../dom.js';
import { RateLimitError } from '../security/rate-limiter.js';
import { QueueFullError, DuplicateJobError, TimeoutError, CancelledError } from '../security/resource-limits.js';
import { ROLES, CONTENT_TYPES } from '../config.js';

export const GLOSSARY = {
  'TF-IDF': 'Term frequency–inverse document frequency: words count more when they are frequent in a document but rare across the documents being compared.',
  'cosine similarity': 'Compares two lists of numbers by the angle between them: 1 means they point the same way, 0 means unrelated.',
  'n-gram': 'A run of n consecutive words. Shared 5-word runs are rarely coincidental.',
  'containment': 'The share of one document’s word runs that also appear in the other document.',
  'Jaccard': 'Shared items divided by all distinct items in both sets.',
  'stylometry': 'Measuring writing style from countable habits: sentence length, punctuation, function words and so on.',
  'z-score': 'How many units of natural variation separate two measurements. Under 1 is small; above 2.5 is large.',
  'SSIM': 'Structural similarity index: compares local brightness, contrast and structure of two images (1 = identical).',
  'chamfer distance': 'Average distance from each stroke pixel in one signature to the nearest stroke pixel in the other.',
  'Isolation Forest': 'An outlier detector that measures how quickly a segment can be separated from the rest by random splits.',
  'MAD': 'Median absolute deviation — a measure of spread that is not thrown off by a few extreme values.',
  'OCR confidence': 'The OCR engine’s own estimate of how sure it is about the recognised characters (0–100).',
  'Sauvola thresholding': 'Turns a photo into ink/paper pixels using local brightness, so shadows do not swallow the text.',
};

/** A technical term with an accessible explanation (tooltip on hover/focus, text for screen readers). */
export function term(word, key = word) {
  const text = GLOSSARY[key];
  if (!text) return word;
  return h('span', { class: 'term', tabindex: '0', title: text, 'aria-label': `${word}: ${text}` }, word);
}

export function pageHeader(title, lede, ...extra) {
  return h('header', { class: 'sheet taped paper-grain' },
    h('h1', { text: title }),
    lede ? h('p', { class: 'lede', text: lede }) : null,
    ...extra);
}

const STAMP_KIND = {
  High: 's-high', Moderate: 's-moderate', Low: 's-low', Inconclusive: 's-neutral',
  'Potential match': 's-high', 'Limited overlap': 's-moderate', 'No match found': 's-low',
  'No anomalies flagged': 's-low', 'Not enough material': 's-neutral',
  Accepted: 's-ok', completed: 's-ok', failed: 's-bad', skipped: 's-neutral', 'not run': 's-neutral',
  similar: 's-low', match: 's-low', partial: 's-moderate', different: 's-high', differs: 's-high',
};
export function stamp(label, kind) {
  const k = kind || STAMP_KIND[label] || (/to review$/.test(label) ? 's-high' : /^Rejected/.test(label) ? 's-bad' : 's-neutral');
  return h('span', { class: `stamp ${k}`, text: label });
}

/** Verdict words for similarity labels so they never read as accusations. */
export function similarityPhrase(label) {
  return { High: 'High similarity', Moderate: 'Moderate similarity', Low: 'Low similarity', Inconclusive: 'Inconclusive' }[label] || label;
}

export function notice(kind, title, ...body) {
  return h('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : null }, title ? h('strong', { text: title }) : null, title ? ' ' : null, ...body);
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', { text }), action || null);
}

export function linkKey(href, label, quiet = false) {
  return h('a', { class: `key${quiet ? ' key-quiet' : ''}`, href }, label);
}

export function table({ caption, headers, rows, numeric = [] }) {
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': caption || 'Table', tabindex: '0' },
    h('table', { class: 'ledger' },
      caption ? h('caption', { text: caption }) : null,
      h('thead', {}, h('tr', {}, headers.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c ?? '—')))))));
}

export function metricList(pairs) {
  return h('ul', { class: 'metric-list' }, pairs.map(([k, v]) => h('li', {}, h('span', {}, k), h('span', { class: 'v' }, v))));
}

export function select(id, options, value, onChange, label) {
  const sel = h('select', { id, on: { change: (e) => onChange(e.target.value) } },
    options.map((o) => h('option', { value: o.id, selected: o.id === value ? true : null, text: o.label })));
  return h('div', {}, h('label', { for: id, text: label }), sel);
}

export const roleSelect = (doc, onChange) => select(`role-${doc.id}`, ROLES, doc.role, onChange, 'Role');
export const typeSelect = (doc, onChange) => select(`type-${doc.id}`, CONTENT_TYPES, doc.contentType, onChange, 'Content');

/** Confirmation using the native <dialog>. */
export function confirmAction(message, okLabel = 'Continue') {
  const dlg = document.getElementById('confirm-dialog');
  document.getElementById('confirm-message').textContent = message;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); ok.removeEventListener('click', yes); cancel.removeEventListener('click', no); dlg.removeEventListener('cancel', no); resolve(v); };
    const yes = () => done(true);
    const no = () => done(false);
    ok.addEventListener('click', yes);
    cancel.addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
    cancel.focus();
  });
}

let toastTimer;
export function toast(message, ms = 4500) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.append(t);
  announce(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/** Friendly, safe explanation of an error (never a stack trace). */
export function explainError(err) {
  if (err instanceof RateLimitError) return `${err.message} You can try again in about ${Math.ceil(err.retryAfterSec / 60)} minute${err.retryAfterSec > 60 ? 's' : ''}.`;
  if (err instanceof QueueFullError || err instanceof DuplicateJobError || err instanceof TimeoutError || err instanceof CancelledError) return err.message;
  if (err && typeof err.message === 'string' && err.message.length < 240) return err.message;
  return 'Something went wrong while processing. Your documents were not sent anywhere; try again or clear the session.';
}

export function mountView(root, ...children) {
  mount(root, ...children);
}

export function docName(d) {
  return d?.displayName || 'Unknown document';
}

export function docPicker(id, docs, value, onChange, label) {
  return select(id, docs.map((d) => ({ id: d.id, label: d.displayName })), value, onChange, label);
}
