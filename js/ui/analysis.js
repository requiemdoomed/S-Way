/** New analysis: upload workspace, document configuration, module selection, run & progress. */
import { h, mount, clear, formatBytes, announce } from '../dom.js';
import { UPLOAD_LIMITS, MODULES, TIMEOUTS } from '../config.js';
import { validateFile, checkBatch, STATUS, STATUS_LABEL } from '../security/validation.js';
import { limiter } from '../security/rate-limiter.js';
import { withTimeout } from '../security/resource-limits.js';
import { secureId } from '../security/sanitize.js';
import { revokeObjectUrl } from '../security/blob-registry.js';
import { pdfPreflight, imageThumb, ExtractionError } from '../engines/extract.js';
import { session, docList, changed, removeDocument } from '../core/state.js';
import { startAnalysis, moduleAvailability, queue, analysisWorker } from '../core/orchestrator.js';
import { pageHeader, stamp, notice, roleSelect, typeSelect, explainError, toast } from './common.js';
import { refreshView } from './bus.js';

/** Job state survives navigation so progress is visible when returning to this page. */
const run = { job: null, log: [], frac: 0, error: null, selected: null };
let preset = null;

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function renderAnalysis(root, arg) {
  if (arg === 'text') preset = ['text', 'style'];
  const docs = docList();
  const avail = moduleAvailability(docs);
  if (!run.selected || preset) {
    run.selected = new Set((preset || MODULES.map((m) => m.id)).filter((id) => avail[id]?.ok || !docs.length));
    preset = null;
  }
  const accepted = docs.filter((d) => d.validation?.accepted);

  mount(root,
    pageHeader('New analysis', 'Feed documents into the machine, tell S-Way what each one is, choose the checks, and run. Nothing leaves this tab.'),
    feeder(),
    samplePicker(docs.length === 0),
    accepted.length === 1 ? notice('warn', 'One document loaded.', 'Comparisons need at least two. With one document you can still extract its text, inspect its pages and run anomaly screening.') : null,
    docs.length ? h('section', { class: 'stack', 'aria-labelledby': 'docs-title' },
      h('div', { class: 'spread' },
        h('h2', { id: 'docs-title', text: `Documents (${accepted.length} accepted${docs.length > accepted.length ? `, ${docs.length - accepted.length} rejected` : ''})` }),
        h('p', { class: 'fine', text: 'Roles are optional. S-Way never assumes the first document is the authentic one.' })),
      h('div', { class: 'doc-grid' }, docs.map((d) => docCard(d)))) : null,
    accepted.length ? modulePicker(avail) : null,
    accepted.length ? runPanel(accepted) : null,
  );
}

// ------------------------------------------------------------ upload
function feeder() {
  const input = h('input', { type: 'file', id: 'file-input', multiple: true, accept: ACCEPT, class: 'visually-hidden', on: { change: (e) => { addFiles(e.target.files); e.target.value = ''; } } });
  const zone = h('div', {
    class: 'dropzone paper-grain',
    role: 'button',
    tabindex: '0',
    'aria-describedby': 'drop-help',
    on: {
      click: () => input.click(),
      keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
      dragenter: (e) => { e.preventDefault(); zone.classList.add('dragging'); },
      dragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      dragleave: (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging'); },
      drop: (e) => { e.preventDefault(); zone.classList.remove('dragging'); addFiles(e.dataTransfer.files); },
    },
  },
  h('div', {},
    h('h3', { text: 'Drop documents onto the sheet' }),
    h('p', { id: 'drop-help', text: `or press to choose files · PDF, PNG, JPEG, WEBP, DOCX, TXT · up to ${UPLOAD_LIMITS.maxFilesPerAnalysis} files, ${UPLOAD_LIMITS.maxFileBytes / 1048576} MB each` }),
    h('span', { class: 'key key-small', 'aria-hidden': 'true' }, 'Choose files')));
  return h('section', { class: 'feeder', 'aria-label': 'Upload documents' }, input, zone, h('div', { class: 'platen', 'aria-hidden': 'true' }));
}

// ------------------------------------------------------------ sample documents
const SAMPLE_SETS = [
  { id: 'essays', title: 'Essays & a source', what: 'Text similarity, style and source matching on three short essays (one is marked as the source).',
    files: [['essay_a.txt', 'source', 'digital'], ['essay_b.docx', 'submission', 'digital'], ['essay_c.txt', 'submission', 'digital']], modules: ['text', 'style', 'source'] },
  { id: 'handwriting', title: 'Handwritten pages', what: 'Three pages by two synthetic writers — handwriting features, edge-hinge texture and line screening.',
    files: [['hand_writer1_a.png', 'known', 'handwritten'], ['hand_writer1_b.png', 'unknown', 'handwritten'], ['hand_writer2_a.png', 'unknown', 'handwritten']], modules: ['handwriting', 'layout', 'anomaly'] },
  { id: 'signatures', title: 'Signatures', what: 'Two signatures from one synthetic signer and one from another — aligned visual comparison.',
    files: [['sig_person1_a.png', 'known', 'signature'], ['sig_person1_b.png', 'unknown', 'signature'], ['sig_person2_a.png', 'unknown', 'signature']], modules: ['signature'] },
  { id: 'forensics', title: 'Phone photo & tampered page', what: 'A tilted phone photo (perspective correction + OCR) and a page with a copy-pasted region (duplicate screening).',
    files: [['photo_page.jpg', 'examined', 'printed'], ['scan_a.png', 'reference', 'printed'], ['tampered_copy_move.png', 'examined', 'printed']], modules: ['text', 'layout', 'anomaly'] },
];
const SAMPLE_TYPES = { txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };

function samplePicker(open) {
  return h('details', { class: 'sheet aged paper-grain', open: open ? true : null },
    h('summary', {}, h('strong', { text: 'No documents to hand? Try a sample set' })),
    h('p', { class: 'fine', text: 'Sample files ship with S-Way (public-domain text and synthetic images). They are fetched from this site and pass through exactly the same validation as your own files.' }),
    h('div', { class: 'sample-sets' }, SAMPLE_SETS.map((set) => h('div', { class: 'check' },
      h('strong', { text: set.title }),
      h('span', { class: 'why', text: set.what }),
      h('button', { type: 'button', class: 'key key-small', on: { click: () => loadSamples(set) } }, `Load ${set.files.length} files`)))));
}

async function loadSamples(set) {
  try {
    const files = await Promise.all(set.files.map(async ([name]) => {
      const r = await fetch(`assets/samples/${name}`, { credentials: 'omit' });
      if (!r.ok) throw new Error('missing');
      return new File([await r.blob()], name, { type: SAMPLE_TYPES[name.split('.').pop()] || '' });
    }));
    const presets = new Map(set.files.map(([name, role, contentType]) => [name, { role, contentType }]));
    await addFiles(files, presets);
    run.selected = new Set(set.modules);
    refreshView();
    toast(`${set.title} loaded. Check the roles, then run the analysis.`);
  } catch {
    toast('The sample files could not be loaded from this site.');
  }
}

async function addFiles(fileList, presets = null) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  try {
    limiter.consume('upload');
  } catch (err) { toast(explainError(err)); return; }
  const existing = docList().filter((d) => d.validation?.accepted).map((d) => d.size);
  const batch = checkBatch(existing, files.map((f) => f.size));
  if (!batch.ok) { toast(batch.message); announce(batch.message); return; }

  for (const file of files) {
    const d = { id: secureId(), displayName: file.name, size: file.size, role: 'unassigned', contentType: 'auto', scanned: false, pageCount: null, validation: { accepted: false, status: 'pending', message: 'Checking…' } };
    session.docs.set(d.id, d);
    session.order.push(d.id);
    changed('docs');
    refreshView();
    try {
      // Declared size is untrusted, but a file that claims to be oversized is not even read.
      if (file.size > UPLOAD_LIMITS.maxFileBytes) {
        d.validation = { accepted: false, status: STATUS.SIZE, message: `The file is ${formatBytes(file.size)}; the limit is ${UPLOAD_LIMITS.maxFileBytes / 1048576} MB.` };
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const v = await withTimeout(validateFile({ name: file.name, type: file.type, bytes }), TIMEOUTS.validationMs, 'Validating the file');
        d.validation = v;
        d.displayName = v.displayName || 'Unnamed file';
        d.size = bytes.length;
        if (v.accepted) {
          d.kind = v.kind;
          d.bytes = bytes;
          d.contentType = v.kind === 'docx' || v.kind === 'txt' ? 'digital' : 'auto';
          if (v.kind === 'pdf') {
            const info = await pdfPreflight(bytes);
            d.pageCount = info.pages;
            d.thumb = info.thumb;
          } else if (['png', 'jpeg', 'webp'].includes(v.kind)) {
            d.pageCount = 1;
            d.thumb = await imageThumb(bytes, v.kind, v.details);
          } else {
            d.pageCount = 1;
          }
        }
      }
    } catch (err) {
      d.bytes = null;
      d.validation = { accepted: false, status: err instanceof ExtractionError ? err.status : STATUS.MALFORMED, message: err instanceof ExtractionError ? err.message : 'The file could not be read safely.' };
    }
    if (!d.validation.accepted) d.bytes = null;
    const preset = presets?.get(file.name);
    if (preset && d.validation.accepted) { d.role = preset.role; d.contentType = preset.contentType; }
    announce(`${d.displayName}: ${d.validation.accepted ? 'accepted' : STATUS_LABEL[d.validation.status] || 'rejected'}`);
    if (!presets) run.selected = null; // recompute module defaults for the new document set
    changed('docs');
    refreshView();
  }
}

// ------------------------------------------------------------ document cards
function docCard(d) {
  const v = d.validation || {};
  const pending = v.status === 'pending';
  const label = pending ? 'Checking' : v.accepted ? 'Accepted' : STATUS_LABEL[v.status] || 'Rejected';
  const glyph = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT', png: 'PNG', jpeg: 'JPEG', webp: 'WEBP' }[d.kind] || '?';
  const meta = [];
  if (d.kind) meta.push(glyph);
  meta.push(formatBytes(d.size));
  if (d.pageCount) meta.push(`${d.pageCount} page${d.pageCount === 1 ? '' : 's'}`);
  if (d.scanned) meta.push(`${(d.text?.corrected ?? d.text?.original ?? '').split(/\s+/).filter(Boolean).length.toLocaleString()} words extracted`);
  const remove = h('button', { type: 'button', class: 'key key-quiet key-small', 'aria-label': `Remove ${d.displayName}`, on: { click: () => { removeDocument(d.id, revokeObjectUrl); run.selected = null; refreshView(); } } }, 'Remove');

  return h('article', { class: `doc-card${v.accepted || pending ? '' : ' rejected'}`, 'aria-label': d.displayName },
    h('div', { class: 'doc-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: `First page of ${d.displayName}` }) : h('span', { class: 'type-glyph', 'aria-hidden': 'true', text: glyph })),
    h('div', { class: 'doc-body' },
      stamp(label, pending ? 's-neutral' : null),
      h('div', { class: 'doc-name', text: d.displayName }),
      h('div', { class: 'doc-meta', text: meta.join(' · ') }),
      !v.accepted && !pending ? h('p', { class: 'fine', role: 'alert', text: v.message }) : null,
      d.scanError ? h('p', { class: 'fine', role: 'alert', text: d.scanError }) : null,
      ((d.scanned ? d.warnings : v.warnings)?.length || d.extraction?.ocrConfidence != null) ? h('ul', { class: 'warn-list' },
        ((d.scanned ? d.warnings : v.warnings) || []).map((w) => h('li', { text: w })),
        d.extraction?.ocrConfidence != null ? h('li', { text: `OCR confidence ${d.extraction.ocrConfidence}%${d.extraction.ocrConfidence < 70 ? ' — please review the text' : ''}` }) : null) : null,
      v.accepted ? h('div', { class: 'grid-2' },
        roleSelect(d, (val) => { d.role = val; changed('docs'); run.selected = null; refreshView(); }),
        typeSelect(d, (val) => { d.contentType = val; d.visual = null; changed('docs'); run.selected = null; refreshView(); })) : null,
      h('div', { class: 'row' }, remove, d.scanned ? h('a', { href: `#/compare/${d.id}`, class: 'fine' }, 'Review or correct text') : null)));
}

// ------------------------------------------------------------ modules
function modulePicker(avail) {
  const available = MODULES.filter((m) => avail[m.id].ok);
  const all = available.length > 0 && available.every((m) => run.selected.has(m.id));
  const complete = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: all ? true : null, on: { change: (e) => { run.selected = new Set(e.target.checked ? available.map((m) => m.id) : []); refreshView(); } } }),
    h('span', {}, h('strong', { text: 'Complete analysis' }), h('span', { class: 'why', text: 'Every check that applies to these documents.' })));
  return h('section', { class: 'sheet paper-grain', 'aria-labelledby': 'mods-title' },
    h('h2', { id: 'mods-title', text: 'What should S-Way check?' }),
    h('p', { class: 'fine', text: 'Checks that do not suit the uploaded documents are switched off and say why — a typed PDF, for example, never receives a handwriting result.' }),
    h('div', { class: 'grid-2' }, complete, ...MODULES.map((m) => {
      const a = avail[m.id];
      return h('label', { class: 'check', 'aria-disabled': a.ok ? null : 'true' },
        h('input', { type: 'checkbox', disabled: a.ok ? null : true, checked: a.ok && run.selected.has(m.id) ? true : null, on: { change: (e) => { if (e.target.checked) run.selected.add(m.id); else run.selected.delete(m.id); refreshView(); } } }),
        h('span', {}, m.label, a.reason ? h('span', { class: 'why', text: a.reason }) : null));
    })));
}

// ------------------------------------------------------------ running
function runPanel(accepted) {
  const running = Boolean(run.job);
  const avail = moduleAvailability();
  const chosen = [...run.selected].filter((m) => avail[m]?.ok);
  const startBtn = h('button', { type: 'button', class: 'key', disabled: running || !chosen.length ? true : null, on: { click: () => launch(chosen) } }, 'Run analysis');
  const scanBtn = h('button', { type: 'button', class: 'key key-quiet', disabled: running ? true : null, on: { click: () => launch([]) } }, accepted.every((d) => d.scanned) ? 'Text already extracted' : 'Extract text only');
  if (accepted.every((d) => d.scanned)) scanBtn.disabled = true;
  const cancelBtn = running ? h('button', { type: 'button', class: 'key key-danger', on: { click: () => { queue.cancel(run.job.id); analysisWorker.terminate(); } } }, 'Cancel') : null;

  const log = h('ol', { class: 'teletype', 'aria-live': 'polite', 'aria-label': 'Progress log' });
  for (const entry of run.log.slice(-200)) log.append(logLine(entry));
  const bar = h('span', {});
  bar.style.width = `${Math.round(run.frac * 100)}%`;
  run.render = { log, bar };

  return h('section', { class: 'sheet aged paper-grain', 'aria-labelledby': 'run-title' },
    h('h2', { id: 'run-title', text: running ? 'Analysis in progress' : 'Run' }),
    h('p', { class: 'fine', text: `Processing runs in background workers so the page stays responsive. Each job is limited to ${TIMEOUTS.jobMs / 1000} seconds and can be cancelled at any time.` }),
    !chosen.length && !running ? notice('warn', 'No checks selected.', 'Tick at least one check above, or extract text only.') : null,
    h('div', { class: 'button-row' }, startBtn, scanBtn, cancelBtn),
    run.error ? notice('error', 'The analysis stopped.', run.error) : null,
    run.log.length || running ? h('div', {}, h('div', { class: 'ribbon-bar', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(run.frac * 100)) }, bar), log) : null);
}

function logLine(e) {
  return h('li', { class: e.kind }, h('time', { text: e.time }), h('span', { text: e.text }));
}

function addLog(text, kind = 'info', frac) {
  if (kind === 'progress') {
    if (Number.isFinite(frac)) run.frac = Math.max(0.02, Math.min(1, frac));
    const last = run.log[run.log.length - 1];
    if (last && last.kind === 'progress' && last.text.split(' ').slice(0, 3).join(' ') === text.split(' ').slice(0, 3).join(' ')) {
      last.text = text;
      if (run.render?.log?.lastChild) run.render.log.lastChild.querySelector('span').textContent = text;
      if (run.render?.bar) run.render.bar.style.width = `${Math.round(run.frac * 100)}%`;
      return;
    }
  }
  const entry = { text, kind, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
  run.log.push(entry);
  if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
  if (run.render?.log?.isConnected) {
    run.render.log.append(logLine(entry));
    run.render.log.scrollTop = run.render.log.scrollHeight;
    run.render.bar.style.width = `${Math.round(run.frac * 100)}%`;
  }
}

async function launch(selected) {
  run.error = null;
  run.log = [];
  run.frac = 0.02;
  addLog(selected.length ? `Starting analysis: ${selected.map((m) => MODULES.find((x) => x.id === m).label).join(', ')}` : 'Extracting text and page images', 'info');
  try {
    run.job = startAnalysis(selected, addLog);
  } catch (err) {
    run.error = explainError(err);
    run.job = null;
    refreshView();
    return;
  }
  refreshView();
  try {
    const report = await run.job.promise;
    run.frac = 1;
    addLog(selected.length ? `Report ready (${(report.durationMs / 1000).toFixed(1)} s)` : 'Extraction complete', 'ok');
    run.job = null;
    toast(selected.length ? 'Analysis complete. Opening the report.' : 'Text extracted. Review it under Document comparison.');
    if (selected.length) location.hash = '#/reports';
    else refreshView();
  } catch (err) {
    run.job = null;
    run.error = explainError(err);
    addLog(run.error, 'error');
    refreshView();
  }
}
