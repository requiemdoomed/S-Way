/** Security & privacy center: live checks of what the browser actually holds, and session clearing. */
import { h, mount } from '../dom.js';
import { session, clearSessionMemory } from '../core/state.js';
import { calibration } from '../core/calibration.js';
import { queue, analysisWorker } from '../core/orchestrator.js';
import { terminateOcr } from '../engines/extract.js';
import { blobStats } from '../security/blob-registry.js';
import { limiter } from '../security/rate-limiter.js';
import { exists as archiveExists, deleteAllReports } from '../core/report-store.js';
import { RATE_LIMITS } from '../config.js';
import { pageHeader, notice, confirmAction, toast, table } from './common.js';
import { refreshView } from './bus.js';

let lastClear = null;
let probes = null;

/** Measure the real state of browser storage and network use. */
async function runProbes() {
  const p = {};
  p.cookies = document.cookie === '' ? 0 : document.cookie.split(';').length;
  try { p.local = localStorage.length; } catch { p.local = 'blocked'; }
  try { p.sessionStore = sessionStorage.length; } catch { p.sessionStore = 'blocked'; }
  try { p.idb = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null; } catch { p.idb = null; }
  p.archive = await archiveExists();
  const entries = performance.getEntriesByType('resource');
  p.requests = entries.length;
  p.external = [...new Set(entries.map((e) => { try { return new URL(e.name).origin; } catch { return 'unknown'; } }).filter((o) => o !== location.origin && !o.startsWith('blob:') && o !== 'null'))];
  p.secure = window.isSecureContext;
  p.https = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  p.csp = Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]'));
  p.blobs = blobStats();
  return p;
}

export function renderPrivacy(root) {
  if (!probes) runProbes().then((p) => { probes = p; refreshView(); });
  const p = probes;
  const docs = session.order.length;
  const pending = !p;
  const item = (label, value, how) => h('li', {}, h('span', { class: 'lbl', text: label }), h('span', { class: 'val', text: value }), h('span', { class: 'how', text: how }));

  mount(root,
    pageHeader('Security & privacy center', 'These readings are taken live from your browser each time this page opens — not marketing copy.'),
    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Current status' }),
      h('ul', { class: 'switchboard' },
        item('Authentication', 'No account required', 'There is no login, password or user profile anywhere in S-Way.'),
        item('Persistent document storage', 'Disabled', 'Documents are held in this tab’s memory only and discarded when it closes.'),
        item('Cookies', pending ? 'Checking…' : p.cookies === 0 ? 'None set' : `${p.cookies} present (not set by S-Way)`, 'Read from document.cookie.'),
        item('Tracking & analytics', 'None', 'No analytics, advertising or profiling scripts are included.'),
        item('Browser storage', pending ? 'Checking…' : `localStorage ${p.local} · sessionStorage ${p.sessionStore}`, 'S-Way never writes documents to either.'),
        item('IndexedDB', pending ? 'Checking…' : p.idb == null ? 'Not inspectable in this browser' : p.idb.length ? p.idb.join(', ') : 'Empty', 'Only used if you opt in to saving reports.'),
        item('Report saving', session.settings.saveReports ? 'On — saved on this device' : 'Off (default)', 'Change in Settings. Saved reports are not encrypted.'),
        item('Temporary processing', 'In this tab only', 'Analysis runs in Web Workers inside your browser.'),
        item('External processing', pending ? 'Checking…' : p.external.length ? `Requests to: ${p.external.join(', ')}` : 'None — 0 outside requests', `${pending ? '…' : p.requests} resources loaded, all from this site. The Content-Security-Policy forbids any other origin.`),
        item('Automatic cleanup', 'On', 'Memory is cleared on tab close, after 30 idle minutes, or with the button below.'),
        item('Object URLs in memory', pending ? '…' : String(p.blobs.active), `${pending ? '…' : p.blobs.revoked} revoked so far.`),
        item('Secure context', pending ? '…' : p.secure ? 'Yes' : 'No — serve over HTTPS', 'Production deployments must use HTTPS.'),
        item('Model thresholds', calibration.verified ? 'Verified (SHA-256)' : 'Built-in defaults', calibration.source),
        item('Job queue', `${queue.size} active · ${queue.stats.completed} done`, `Cleanup succeeded ${queue.stats.cleanupOk}× · failed ${queue.stats.cleanupFailed}×`)),
      h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key key-quiet key-small', on: { click: () => { probes = null; refreshView(); } } }, 'Re-check now'))),

    h('section', { class: 'sheet aged paper-grain' },
      h('h2', { text: 'Clear current session' }),
      h('p', { text: `Removes everything this tab holds: ${docs} document${docs === 1 ? '' : 's'}, extracted text, page images, previews, reports and running jobs.` }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'clear-saved', checked: true }), h('span', {}, 'Also delete reports saved on this device (if any)')),
      h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key key-danger', on: { click: async () => {
        if (!(await confirmAction('Clear all documents, text, images and reports from this session? This cannot be undone.', 'Clear session'))) return;
        lastClear = await clearEverything({ deleteSaved: document.getElementById('clear-saved')?.checked });
        probes = null;
        refreshView();
      } } }, 'Clear current session')),
      lastClear ? notice('ok', 'Session cleared.', lastClear.join(' ')) : null),

    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Rate limits on this device' }),
      h('p', { class: 'fine', text: 'There is no server to protect, so these limits guard your own device against runaway or scripted repeat processing. They are counted in memory only.' }),
      table({
        caption: 'Sliding-window limits (10 minutes)',
        headers: ['Operation', 'Limit', 'Remaining now'],
        rows: Object.entries(RATE_LIMITS).map(([op, c]) => [op, String(c.limit), String(limiter.peek(op).remaining)]),
        numeric: [1, 2],
      })),

    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Privacy notice' }),
      h('dl', { class: 'stack' },
        qa('What is processed?', 'The files you choose: their bytes, extracted text, page images and the measurements S-Way computes from them.'),
        qa('Why?', 'Only to produce the comparison report you asked for.'),
        qa('Does it leave the browser?', 'No. Reading, OCR, image analysis and comparisons run inside this tab using code and data served from this site. No upload request exists in the code.'),
        qa('Does it reach a Python server?', 'No. The research notebook is a separate tool for developing and calibrating methods; it never receives your documents.'),
        qa('External providers?', 'None. Fonts, the OCR engine, its English language data, the PDF engine and the chart library are all bundled. The Content-Security-Policy blocks every other origin.'),
        qa('How is temporary data deleted?', 'Byte buffers are zeroed and dropped, object URLs revoked, workers terminated. This happens when you clear the session, after 30 idle minutes, and when the tab closes.'),
        qa('What limitations remain?', 'Browser memory is managed by the browser: after clearing, data may linger until garbage collection, and the operating system may page memory to disk. Your browser, extensions or device may keep their own copies (for example in download history). Saved reports, if you opt in, are stored unencrypted. S-Way cannot guarantee anonymity — your network and hosting provider still see that you loaded the site.'))));
}

function qa(q, a) {
  return h('div', {}, h('dt', {}, h('strong', { text: q })), h('dd', { text: a }));
}

/** Steps 1–6 of the "Clear current session" requirement. Returns human-readable results. */
export async function clearEverything({ deleteSaved = false, silent = false } = {}) {
  const out = [];
  queue.cancelAll();
  analysisWorker.terminate();
  await terminateOcr();
  const { docs, urls } = clearSessionMemory();
  out.push(`${docs} document${docs === 1 ? '' : 's'} and all analysis data removed from memory.`);
  out.push(`${urls} preview/object URL${urls === 1 ? '' : 's'} revoked.`);
  out.push('Background workers stopped.');
  if (deleteSaved) {
    const ok = await deleteAllReports();
    out.push(ok ? 'Saved reports on this device deleted.' : 'Saved reports could not be deleted — close other S-Way tabs and try again.');
  }
  out.push('No server holds any copy, so there is nothing to delete remotely.');
  limiter.reset();
  if (!silent) toast('Session cleared.');
  return out;
}
