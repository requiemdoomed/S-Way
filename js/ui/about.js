/** About S-Way: purpose, author, methods, limitations, glossary and third-party licences. */
import { h, mount } from '../dom.js';
import { APP } from '../config.js';
import { calibration } from '../core/calibration.js';
import { pageHeader, GLOSSARY, table } from './common.js';

export function renderAbout(root) {
  mount(root,
    pageHeader('About S-Way', APP.title),
    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Why it exists' }),
      h('p', { text: 'Questions about whether two documents share a source, a writer or a hand are usually answered with a single “similarity percentage”. That number hides how it was reached and invites over-confident conclusions. S-Way separates the question into seven measurable lines of evidence, shows the measurements behind each one, and says plainly where the evidence is thin.' }),
      h('p', {}, 'Designed and built by ', h('strong', { text: APP.author }), `. Version ${APP.version}.`),
      h('p', { class: 'disclaimer-band', text: APP.disclaimer })),
    h('section', { class: 'grid-2' },
      h('div', { class: 'sheet paper-grain' },
        h('h2', { text: 'How it works' }),
        h('ol', {},
          h('li', { text: 'Every file is checked by its contents — signature bytes, structure, sizes, archive safety — before anything opens it.' }),
          h('li', { text: 'Text is read from PDF text layers, DOCX XML or plain text; scanned pages and photos go through Tesseract OCR compiled to WebAssembly.' }),
          h('li', { text: 'Page images are cleaned on working copies: perspective correction of phone photos, resizing, denoising, contrast, adaptive thresholding, deskewing and line segmentation.' }),
          h('li', { text: 'Seven independent modules measure text, style, handwriting, signatures, sources, layout and internal consistency in a background worker.' }),
          h('li', { text: 'Evidence fusion labels each result, flags weak evidence and conflicts, and lists other explanations. Nothing is averaged.' }))),
      h('div', { class: 'sheet aged paper-grain' },
        h('h2', { text: 'Known limitations' }),
        h('ul', {},
          h('li', { text: 'OCR is trained for print; handwritten text is read poorly. Correct the text before relying on text results.' }),
          h('li', { text: 'Paraphrase detection is lexical — rewording with different vocabulary can be missed.' }),
          h('li', { text: 'No neural writer- or signature-verification model is shipped: no suitable, licensed and validated model could be bundled for offline use. Handwriting and signature modules are feature-based and experimental.' }),
          h('li', { text: 'Thresholds were set on public-domain texts and synthetic images (see the research notebook), not on real casework.' }),
          h('li', { text: 'OCR language data is English only.' }),
          h('li', { text: 'Copy-move screening misses rescaled or rotated pastes, content spliced in from other images and very small edits; a clean result does not prove a page is unaltered.' })))),
    h('section', { class: 'sheet paper-grain' },
      h('h2', { text: 'Glossary' }),
      h('dl', { class: 'stack' }, Object.entries(GLOSSARY).map(([k, v]) => h('div', {}, h('dt', {}, h('strong', { text: k })), h('dd', { text: v }))))),
    h('section', { class: 'sheet aged paper-grain' },
      h('h2', { text: 'Included open-source components' }),
      table({
        caption: 'Served from this site; no CDN',
        headers: ['Component', 'Purpose', 'Licence'],
        rows: [
          ['PDF.js 6.5', 'Reading and rendering PDFs', 'Apache-2.0'],
          ['Tesseract.js 7 / tesseract.js-core 7', 'OCR (WebAssembly)', 'Apache-2.0'],
          ['Tesseract English LSTM data (best_int)', 'OCR language model', 'Apache-2.0'],
          ['Chart.js 4.6', 'Charts', 'MIT'],
          ['Special Elite', 'Typeface', 'Apache-2.0'],
          ['Courier Prime', 'Typeface', 'SIL Open Font License 1.1'],
        ],
      }),
      h('p', { class: 'fine', text: `Analysis thresholds: ${calibration.source}.` })));
}
