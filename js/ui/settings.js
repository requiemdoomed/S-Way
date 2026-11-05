/** Settings: theme, motion, opt-in report saving, and a read-only view of the limits. */
import { h, mount } from '../dom.js';
import { session, changed } from '../core/state.js';
import { deleteAllReports } from '../core/report-store.js';
import { UPLOAD_LIMITS, TIMEOUTS, RENDER_LIMITS, ARCHIVE_LIMITS } from '../config.js';
import { pageHeader, select, notice, confirmAction, toast, table } from './common.js';
import { refreshView } from './bus.js';

export function effectiveDark() {
  const t = session.settings.theme;
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyTheme() {
  document.documentElement.dataset.theme = session.settings.theme;
  document.documentElement.dataset.motion = session.settings.motion;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = effectiveDark() ? 'Daylight' : 'Lamplight';
}

export function renderSettings(root) {
  const s = session.settings;
  mount(root,
    pageHeader('Settings', 'Preferences live in memory and reset when you reload — S-Way stores no settings unless you opt in to saving reports.'),
    h('section', { class: 'sheet paper-grain stack' },
      h('h2', { text: 'Appearance' }),
      h('div', { class: 'grid-2' },
        select('set-theme', [{ id: 'auto', label: 'Follow my device' }, { id: 'light', label: 'Daylight (light)' }, { id: 'dark', label: 'Lamplight (dark)' }], s.theme, (v) => { s.theme = v; applyTheme(); changed('settings'); }, 'Theme'),
        select('set-motion', [{ id: 'auto', label: 'Follow my device' }, { id: 'reduce', label: 'Reduce motion' }], s.motion, (v) => { s.motion = v; applyTheme(); }, 'Animation'))),
    h('section', { class: 'sheet aged paper-grain stack' },
      h('h2', { text: 'Save reports on this device' }),
      h('p', { text: 'Off by default. When on, a “Save on this device” button appears on reports. Saved reports contain findings, measurements and text excerpts — never the uploaded files — and are kept in this browser’s IndexedDB.' }),
      notice('warn', 'Not encrypted.', 'Browser storage is not encrypted. Anyone with access to this browser profile could read saved reports. Do not enable this on a shared computer.'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: s.saveReports ? true : null, on: { change: (e) => { s.saveReports = e.target.checked; toast(s.saveReports ? 'Report saving enabled for this tab.' : 'Report saving disabled. Existing saved reports remain until you delete them.'); refreshView(); } } }),
        h('span', {}, 'Enable saving reports on this device (this tab only; resets on reload)')),
      h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'key key-danger', on: { click: async () => {
        if (!(await confirmAction('Delete every report saved on this device?', 'Delete all'))) return;
        toast((await deleteAllReports()) ? 'All saved reports deleted.' : 'Could not delete saved reports — close other S-Way tabs and retry.');
      } } }, 'Delete all saved reports'))),
    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Processing limits' }),
      h('p', { class: 'fine', text: 'Fixed for safety. They stop oversized or hostile files from exhausting your device.' }),
      table({
        caption: 'Current limits',
        headers: ['Limit', 'Value'],
        rows: [
          ['Largest file', `${UPLOAD_LIMITS.maxFileBytes / 1048576} MB`],
          ['Files per analysis', String(UPLOAD_LIMITS.maxFilesPerAnalysis)],
          ['Combined upload', `${UPLOAD_LIMITS.maxCombinedBytes / 1048576} MB`],
          ['PDF pages', String(UPLOAD_LIMITS.maxPdfPages)],
          ['Image dimensions', `${UPLOAD_LIMITS.maxImageWidth} × ${UPLOAD_LIMITS.maxImageHeight} px (${UPLOAD_LIMITS.maxImagePixels / 1e6} MP)`],
          ['Extracted text', `${UPLOAD_LIMITS.maxExtractedChars.toLocaleString()} characters`],
          ['DOCX expanded size', `${UPLOAD_LIMITS.maxDocxExpandedBytes / 1048576} MB, ${ARCHIVE_LIMITS.maxEntries} entries, ratio ≤ ${ARCHIVE_LIMITS.maxCompressionRatio}:1`],
          ['Job time limit', `${TIMEOUTS.jobMs / 1000} s`],
          ['OCR per page', `${TIMEOUTS.ocrPageMs / 1000} s; at most ${RENDER_LIMITS.maxOcrPagesPerAnalysis} pages per analysis`],
          ['Rendering', `longest side ${RENDER_LIMITS.maxWorkingSide} px; first ${RENDER_LIMITS.maxVisualPagesPerDoc} pages per document for visual analysis`],
        ],
      })));
}
