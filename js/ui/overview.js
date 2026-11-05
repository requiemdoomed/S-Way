/** Overview: landing page + dashboard. */
import { h, mount } from '../dom.js';
import { APP, UPLOAD_LIMITS } from '../config.js';
import { session } from '../core/state.js';
import { linkKey } from './common.js';

const CAPABILITIES = [
  ['Text similarity', 'Exact and near-identical passages, word n-grams, TF-IDF and possible paraphrases, with highlights in both documents.', 'PDF, DOCX, TXT, scanned pages via OCR'],
  ['Writing-style comparison', '57 measurable habits — sentence rhythm, punctuation, function words — compared against each text’s own variation.', 'Any text of 300+ words'],
  ['Handwriting features', 'Slant, spacing, stroke width, baseline wobble, letter proportions and stroke texture on page photos and scans.', 'PNG, JPEG, WEBP, scanned PDF'],
  ['Signature visual comparison', 'Normalised, aligned overlays with shape and stroke-distance measures and a difference map.', 'Signature crops or regions you select'],
  ['Source investigation', 'Matches each examined document against the source material you supply in this session.', 'Documents marked as sources'],
  ['Layout & formatting', 'Margins, spacing, density, alignment, fonts and page numbering.', 'Page images, PDF, DOCX'],
  ['Anomaly screening', 'Segments, handwriting lines or pages that behave unlike the rest of the same document, plus metadata checks.', 'Longer texts, multi-line pages'],
];

export function renderOverview(root) {
  const tw = document.getElementById('tpl-typewriter').content.cloneNode(true);
  const reports = session.history.length;
  const docs = session.order.length;

  mount(root,
    h('section', { class: 'hero', 'aria-labelledby': 'hero-title' },
      h('div', { class: 'hero-sheet paper-grain' },
        h('h1', { id: 'hero-title', text: APP.name }),
        h('p', { class: 'full-name', text: 'SmartWay — Intelligent Document Authenticity and Authorship Analysis System' }),
        h('p', {}, h('span', { class: 'typed', text: APP.tagline })),
        h('p', { class: 'intro' },
          'Feed in two or more documents — handwritten pages, scans, PDFs, Word files, signatures — and S-Way examines them from seven separate angles, then types up an evidence report you can check line by line. Everything happens inside this browser tab: nothing is uploaded, stored or tracked.'),
        h('div', { class: 'row hero-actions' },
          linkKey('#/analysis', 'Start a new analysis'),
          linkKey('#/privacy', 'How your documents are handled', true))),
      tw),

    h('section', { class: 'stack', 'aria-labelledby': 'dash-title' },
      h('h2', { id: 'dash-title', text: 'What would you like to examine?' }),
      h('div', { class: 'pinboard' },
        note('#/analysis', 'Start new analysis', 'Upload documents, choose what to check, get a full report.'),
        note('#/compare', 'Compare documents', 'Side-by-side text and pages with every match highlighted.'),
        note('#/handwriting', 'Handwriting lab', 'Measure and compare the features of handwritten pages.'),
        note('#/signature', 'Signature lab', 'Select signatures, align them and inspect the differences.'),
        note('#/analysis/text', 'Text similarity', 'Check two texts for copied, near-identical or reworded passages.'),
        note('#/source', 'Source investigation', 'Trace passages back to the source documents you supply.'),
        note('#/reports', 'Session history', reports ? `${reports} report${reports === 1 ? '' : 's'} from this tab. They disappear when it closes.` : docs ? `${docs} document${docs === 1 ? '' : 's'} waiting. No reports yet.` : 'Empty. Reports live only while this tab stays open.'),
        note('#/privacy', 'Security & privacy center', 'Live checks of storage, cookies and network use — and a button to wipe the session.'))),

    h('section', { class: 'grid-2' },
      h('div', { class: 'sheet paper-grain' },
        h('h2', { text: 'Seven separate lines of evidence' }),
        h('p', { text: 'Each is reported on its own. S-Way never blends them into a single score.' }),
        h('dl', { class: 'stack' }, CAPABILITIES.map(([t, d, inp]) => h('div', {},
          h('dt', {}, h('strong', { text: t })),
          h('dd', { class: 'fine' }, d, h('br'), h('em', { text: `Works with: ${inp}` })))))),
      h('div', { class: 'stack' },
        h('div', { class: 'sheet aged paper-grain' },
          h('h2', { text: 'Accepted formats' }),
          h('ul', { class: 'format-list' }, ['PDF', 'PNG', 'JPG / JPEG', 'WEBP', 'DOCX', 'TXT'].map((f) => h('li', { text: f }))),
          h('p', { class: 'fine', text: `Up to ${UPLOAD_LIMITS.maxFilesPerAnalysis} files, ${UPLOAD_LIMITS.maxFileBytes / 1048576} MB each and ${UPLOAD_LIMITS.maxCombinedBytes / 1048576} MB in total; PDFs up to ${UPLOAD_LIMITS.maxPdfPages} pages. Every file’s contents are checked — a renamed program or a booby-trapped archive is turned away before anything opens it.` })),
        h('div', { class: 'sheet paper-grain' },
          h('h2', { text: 'Privacy in brief' }),
          h('ul', {},
            h('li', { text: 'No account, no login, no cookies, no analytics.' }),
            h('li', { text: 'Documents are read and analysed inside this tab only; no server receives them.' }),
            h('li', { text: 'OCR and PDF engines are served from this site — no outside services.' }),
            h('li', { text: 'Closing the tab, or pressing “Clear current session”, discards everything.' }))))),

    h('section', { class: 'sheet aged paper-grain', 'aria-labelledby': 'limits-title' },
      h('h2', { id: 'limits-title', text: 'Read this before relying on a result' }),
      h('p', { text: 'S-Way is an evidence-assistance and screening tool. A similarity is not proof of copying, shared authorship or forgery: different people write alike, one person writes differently on different days, and scans, OCR errors and templates all leave their mark.' }),
      h('p', { class: 'disclaimer-band', text: APP.disclaimer }),
      h('p', { class: 'fine' }, 'Designed and built by ', h('strong', { text: APP.author }), '.')),
  );
}

function note(href, title, text) {
  return h('a', { class: 'note paper-grain', href }, h('h3', { text: title }), h('p', { text }));
}
