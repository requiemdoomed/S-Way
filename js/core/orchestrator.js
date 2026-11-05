/**
 * Analysis orchestrator: scanning (validation already done → extraction/OCR),
 * per-module execution in the analysis worker, evidence fusion and report assembly.
 *
 * Every job runs through the bounded JobQueue, is rate-limited, has a total time
 * budget and per-step timeouts, can be cancelled, and always runs its cleanup.
 */
import { TIMEOUTS, RENDER_LIMITS, MODULES, APP, EVIDENCE_MINIMUMS } from '../config.js';
import { JobQueue, withTimeout, CancelledError, TimeoutError } from '../security/resource-limits.js';
import { limiter } from '../security/rate-limiter.js';
import { secureId } from '../security/sanitize.js';
import { extractDocument, terminateOcr, ExtractionError } from '../engines/extract.js';
import { metadataConsistency } from '../engines/anomaly.js';
import { compareDigitalFormatting } from '../engines/layout.js';
import { tokenize } from '../engines/text-utils.js';
import { fuseEvidence } from './fusion.js';
import { calibration } from './calibration.js';
import { session, docList, effectiveText, changed } from './state.js';

export const queue = new JobQueue();

// ------------------------------------------------------------ worker wrapper
class AnalysisWorker {
  constructor() { this.worker = null; this.seq = 0; this.pending = new Map(); this.restarts = 0; }

  #ensure() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module', name: 'sway-analysis' });
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      for (const p of this.pending.values()) p.reject(new Error('The analysis worker stopped unexpectedly.'));
      this.pending.clear();
      this.terminate();
    };
    return this.worker;
  }

  call(type, payload, { timeoutMs = TIMEOUTS.moduleMs, token, label = type } = {}) {
    const w = this.#ensure();
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    w.postMessage({ id, type, payload });
    return withTimeout(p, timeoutMs, label, { token, onAbort: () => this.terminate() });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.restarts++;
      for (const p of this.pending.values()) p.reject(new CancelledError());
      this.pending.clear();
    }
  }
}
export const analysisWorker = new AnalysisWorker();

// ------------------------------------------------------------ applicability
export const wordsOf = (d) => tokenize(effectiveText(d)).length;
const isVisual = (d) => d.pages?.length > 0;
export function isHandwritten(d) {
  if (d.contentType === 'handwritten') return true;
  if (d.contentType !== 'auto' || !isVisual(d) || d.detectedType === 'digital') return false;
  return Boolean(bestVisual(d)?.handwriting?.looksHandwritten);
}
export const isSignature = (d) => d.contentType === 'signature' || session.signatureRegions.has(d.id);

/** Which modules can run, with a reason when they cannot. */
export function moduleAvailability(docs = docList()) {
  const ready = docs.filter((d) => d.validation?.accepted);
  // Before scanning, any non-signature document may contain text; after scanning, it must actually have words.
  const text = ready.filter((d) => d.contentType !== 'signature' && (!d.scanned || wordsOf(d) > 0));
  const hw = ready.filter((d) => d.contentType === 'handwritten' || (d.contentType === 'auto' && (d.kind === 'png' || d.kind === 'jpeg' || d.kind === 'webp' || d.kind === 'pdf')));
  const sig = ready.filter((d) => d.contentType === 'signature' || session.signatureRegions.has(d.id));
  const vis = ready.filter((d) => ['pdf', 'png', 'jpeg', 'webp'].includes(d.kind) && d.contentType !== 'signature');
  const src = ready.filter((d) => d.role === 'source' || d.role === 'reference');
  const out = {};
  for (const m of MODULES) {
    let ok = false;
    let reason = '';
    if (m.id === 'text' || m.id === 'style') { ok = text.length >= 2; reason = ok ? '' : 'Needs two documents containing text.'; }
    if (m.id === 'handwriting') { ok = hw.length >= 2; reason = ok ? 'Runs on pages detected or marked as handwritten.' : 'Needs two handwritten page images (mark them as “Handwritten page”).'; }
    if (m.id === 'signature') { ok = sig.length >= 2; reason = ok ? '' : 'Needs two signature images, or signature regions selected in the Signature lab.'; }
    if (m.id === 'source') { ok = src.length >= 1 && ready.length >= 2; reason = ok ? '' : 'Mark at least one document as “Source material” or “Reference document”.'; }
    if (m.id === 'layout') { ok = vis.length >= 2 || ready.filter((d) => d.kind === 'docx' || d.kind === 'pdf').length >= 2; reason = ok ? '' : 'Needs two page images, PDFs or DOCX files.'; }
    if (m.id === 'anomaly') { ok = ready.length >= 1; reason = ok ? '' : 'Needs at least one document.'; }
    out[m.id] = { ok, reason };
  }
  return out;
}

function comparisonPairs(docs) {
  const refRoles = new Set(['reference', 'known', 'source']);
  const tgtRoles = new Set(['examined', 'unknown', 'submission']);
  const refs = docs.filter((d) => refRoles.has(d.role));
  const tgts = docs.filter((d) => tgtRoles.has(d.role));
  const pairs = [];
  if (refs.length && tgts.length) {
    // Each examined document against every reference, plus examined documents against
    // each other (e.g. two submissions that share material with one another).
    for (const t of tgts) for (const r of refs) pairs.push([t, r]);
    for (let i = 0; i < tgts.length; i++) for (let j = i + 1; j < tgts.length; j++) pairs.push([tgts[i], tgts[j]]);
  } else {
    for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) pairs.push([docs[i], docs[j]]);
  }
  return pairs.slice(0, 45);
}

export function bestVisual(d) {
  const v = (d.visual || []).filter(Boolean);
  if (!v.length) return null;
  return v.reduce((best, x) => ((x.lines?.length || 0) > (best.lines?.length || 0) ? x : best), v[0]);
}

// ------------------------------------------------------------ scanning
/** Extract text and page images for every document not yet scanned. */
export async function scanDocuments(log, token) {
  const docs = docList().filter((d) => d.validation?.accepted && !d.scanned);
  if (!docs.length) return;
  const needsOcr = docs.some((d) => ['png', 'jpeg', 'webp', 'pdf'].includes(d.kind) && d.contentType !== 'signature');
  if (needsOcr) limiter.consume('ocr');
  const ocrBudget = { remaining: RENDER_LIMITS.maxOcrPagesPerAnalysis };
  for (const d of docs) {
    token.throwIfCancelled();
    const t0 = performance.now();
    log(`Scanning ${d.displayName}`, 'info');
    try {
      await extractDocument(d, { token, ocrBudget, onProgress: (msg, frac) => log(msg, 'progress', frac) });
      d.scanned = true;
      d.scanError = null;
      d.visual = null;
      const words = wordsOf(d);
      const conf = d.extraction.ocrConfidence;
      log(`${d.displayName}: ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}, ${words.toLocaleString()} words${Number.isFinite(conf) ? `, OCR confidence ${conf}%` : ''} (${Math.round(performance.now() - t0)} ms)`, 'ok');
      if (Number.isFinite(conf) && conf < EVIDENCE_MINIMUMS.ocrConfidence) log(`${d.displayName}: OCR confidence is low — review the extracted text before relying on text results.`, 'warn');
    } catch (err) {
      if (err instanceof CancelledError || err instanceof TimeoutError) throw err;
      d.scanned = false;
      d.scanError = err instanceof ExtractionError ? err.message : 'The document could not be processed.';
      if (err instanceof ExtractionError) {
        d.validation = { ...d.validation, accepted: false, status: err.status, message: err.message };
        d.bytes = null; // a rejected document is dropped from memory
      }
      log(`${d.displayName}: ${d.scanError}`, 'error');
    }
    changed('docs');
  }
}

async function ensureVisualProfiles(docs, log, token) {
  for (const d of docs) {
    if (!isVisual(d)) continue;
    d.visual ||= [];
    for (let i = 0; i < Math.min(d.pages.length, RENDER_LIMITS.maxVisualPagesPerDoc); i++) {
      if (d.visual[i]) continue;
      token.throwIfCancelled();
      log(`Preprocessing ${d.displayName}, page ${d.pages[i].index}`, 'progress');
      const gray = d.pages[i].gray;
      const r = await analysisWorker.call('visualProfile', { gray, wantHandwriting: d.contentType === 'handwritten' || (d.contentType === 'auto' && d.detectedType !== 'digital') }, { token, timeoutMs: TIMEOUTS.preprocessingMs * 2, label: 'Image preprocessing' });
      r.page = d.pages[i].index;
      d.visual[i] = r;
    }
  }
}

// ------------------------------------------------------------ analysis
/**
 * Run the selected modules. Returns the report.
 * @param {string[]} selected module ids
 * @param {(text:string, kind:string, frac?:number)=>void} log
 */
export function startAnalysis(selected, log) {
  limiter.consume('analysis');
  if (selected.some((m) => ['handwriting', 'signature', 'anomaly'].includes(m))) limiter.consume('ml');
  const ids = docList().filter((d) => d.validation?.accepted).map((d) => d.id).sort();
  const fingerprint = `${ids.join(',')}|${[...selected].sort().join(',')}|${ids.map((id) => (session.docs.get(id).text?.corrected ? 'c' : 'o')).join('')}`;
  const job = queue.submit(
    fingerprint,
    (token) => withTimeout(runJob(selected, log, token), TIMEOUTS.jobMs, 'The analysis', { token, onAbort: () => { analysisWorker.terminate(); terminateOcr(); } }),
    async () => { await terminateOcr(); }, // free OCR memory after every job, whatever the outcome
  );
  return job;
}

async function runJob(selected, log, token) {
  const started = performance.now();
  const results = {};
  await scanDocuments(log, token);
  const docs = docList().filter((d) => d.validation?.accepted && d.scanned);
  if (!docs.length) throw new Error('No document could be processed.');
  if (!selected.length) return { scanOnly: true, durationMs: Math.round(performance.now() - started) };
  const needVisual = selected.some((m) => ['handwriting', 'layout', 'anomaly', 'signature'].includes(m));
  if (needVisual) await ensureVisualProfiles(docs, log, token);

  const pairs = comparisonPairs(docs);
  const textDoc = (d) => ({ id: d.id, name: d.displayName, text: effectiveText(d), pageStarts: d.pageStarts || [0] });
  const step = async (module, fn) => {
    if (!selected.includes(module)) return;
    log(`Running ${MODULES.find((m) => m.id === module).label.toLowerCase()}`, 'info');
    try {
      results[module] = await fn();
      log(`${MODULES.find((m) => m.id === module).label} complete`, 'ok');
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      results[module] = { error: err instanceof TimeoutError ? err.message : `This module failed: ${err.message}` };
      log(results[module].error, 'error');
    }
  };

  const textDocs = docs.filter((d) => wordsOf(d) > 0 && d.contentType !== 'signature');
  const textPairs = pairs.filter(([a, b]) => textDocs.includes(a) && textDocs.includes(b));

  await step('text', async () => {
    if (!textPairs.length) return { skipped: 'Fewer than two documents contain text.' };
    const out = [];
    for (const [a, b] of textPairs) out.push(await analysisWorker.call('text', { a: textDoc(a), b: textDoc(b), thresholds: calibration.text }, { token, label: 'Text comparison' }));
    return { pairs: out };
  });

  await step('style', async () => {
    if (!textPairs.length) return { skipped: 'Fewer than two documents contain text.' };
    const out = [];
    for (const [a, b] of textPairs) out.push(await analysisWorker.call('style', { a: textDoc(a), b: textDoc(b) }, { token, label: 'Style comparison' }));
    const cluster = textDocs.length >= 3 ? await analysisWorker.call('cluster', { docs: textDocs.map(textDoc) }, { token, label: 'Style clustering' }) : null;
    return { pairs: out, cluster };
  });

  await step('handwriting', async () => {
    const hw = docs.filter((d) => isHandwritten(d) && bestVisual(d)?.handwriting?.ok);
    if (hw.length < 2) return { skipped: 'Fewer than two pages with measurable handwriting were found. Mark handwritten pages as “Handwritten page” or upload clearer images.' };
    const out = [];
    for (const [a, b] of comparisonPairs(hw)) {
      const fa = bestVisual(a).handwriting;
      const fb = bestVisual(b).handwriting;
      const r = await analysisWorker.call('handwritingCompare', { fa, fb, scales: calibration.handwritingScales }, { token, label: 'Handwriting comparison' });
      out.push({ ...r, pair: [a.id, b.id], pages: [bestVisual(a).page, bestVisual(b).page] });
    }
    return { pairs: out, features: Object.fromEntries(hw.map((d) => [d.id, bestVisual(d).handwriting])) };
  });

  await step('signature', async () => {
    const sig = docs.filter((d) => isSignature(d) && d.pages?.length);
    if (sig.length < 2) return { skipped: 'Fewer than two signatures are available.' };
    const out = [];
    for (const [a, b] of comparisonPairs(sig)) {
      const regionA = session.signatureRegions.get(a.id) || (a.contentType === 'signature' ? null : bestVisual(a)?.signatureSuggestion);
      const regionB = session.signatureRegions.get(b.id) || (b.contentType === 'signature' ? null : bestVisual(b)?.signatureSuggestion);
      const r = await analysisWorker.call('signature', { a: a.pages[0].gray, b: b.pages[0].gray, regionA, regionB }, { token, timeoutMs: TIMEOUTS.signatureMs, label: 'Signature comparison' });
      if (!r.ok) { log(`Signature comparison skipped for ${a.displayName} / ${b.displayName}: ${r.warnings.join(' ')}`, 'warn'); continue; }
      out.push({ ...r, pair: [a.id, b.id], regions: [regionA || 'whole image', regionB || 'whole image'] });
    }
    return out.length ? { pairs: out } : { skipped: 'No signature strokes could be isolated.' };
  });

  await step('source', async () => {
    const sources = textDocs.filter((d) => d.role === 'source' || d.role === 'reference');
    const examined = textDocs.filter((d) => !sources.includes(d));
    if (!sources.length || !examined.length) return { skipped: 'Mark at least one document as “Source material” or “Reference document”, and include another document to examine.' };
    return analysisWorker.call('source', { examined: examined.map(textDoc), sources: sources.map(textDoc), thresholds: calibration.text }, { token, label: 'Source investigation' });
  });

  await step('layout', async () => {
    const vis = docs.filter((d) => bestVisual(d)?.layout?.ok && d.contentType !== 'signature');
    const out = [];
    for (const [a, b] of comparisonPairs(vis)) {
      const r = await analysisWorker.call('layoutCompare', { la: bestVisual(a).layout, lb: bestVisual(b).layout }, { token, label: 'Layout comparison' });
      out.push({ ...r, pair: [a.id, b.id], pages: [bestVisual(a).page, bestVisual(b).page] });
    }
    const digital = [];
    const fmtDocs = docs.filter((d) => d.formatting?.fonts?.length);
    for (const [a, b] of comparisonPairs(fmtDocs)) {
      const r = compareDigitalFormatting(a.formatting, b.formatting);
      if (r) digital.push({ ...r, pair: [a.id, b.id] });
    }
    if (!out.length && !digital.length) return { skipped: 'No comparable page layouts were found.' };
    return { pairs: out, digital };
  });

  await step('anomaly', async () => {
    const out = [];
    for (const d of docs) {
      token.throwIfCancelled();
      const entry = { docId: d.id, flags: [], checks: [], screened: false };
      const text = effectiveText(d);
      if (wordsOf(d) >= 750) {
        const r = await analysisWorker.call('anomalyText', { text }, { token, label: 'Style consistency screening' });
        entry.checks.push({ check: 'Writing-style consistency', ...r });
        if (r.ok) { entry.screened = true; entry.flags.push(...r.flags.map((f) => ({ ...f, kind: 'style' }))); }
      } else entry.checks.push({ check: 'Writing-style consistency', ok: false, reason: 'Needs at least 750 words.' });
      const bv = bestVisual(d);
      if (bv?.handwriting?.ok && isHandwritten(d)) {
        const r = await analysisWorker.call('anomalyHandwriting', { perLine: bv.handwriting.perLine }, { token, label: 'Handwriting consistency screening' });
        entry.checks.push({ check: 'Handwriting line consistency', page: bv.page, ...r });
        if (r.ok) { entry.screened = true; entry.flags.push(...r.flags.map((f) => ({ ...f, kind: 'handwriting', page: bv.page }))); }
      }
      const layouts = (d.visual || []).filter(Boolean).map((v) => ({ ...v.layout, page: v.page }));
      if (layouts.length >= 3) {
        const r = await analysisWorker.call('anomalyLayout', { pages: layouts }, { token, label: 'Layout consistency screening' });
        entry.checks.push({ check: 'Page layout consistency', ...r });
        if (r.ok) { entry.screened = true; entry.flags.push(...r.flags.map((f) => ({ ...f, kind: 'layout' }))); }
      }
      const visuals = (d.visual || []).filter(Boolean);
      if (visuals.length && d.contentType !== 'signature') {
        const dups = visuals.flatMap((v) => (v.duplicates?.regions || []).map((r) => ({ ...r, page: v.page })));
        entry.checks.push({ check: 'Duplicated-region (copy-move) screening', ok: true, pages: visuals.length, flags: dups });
        entry.screened = true;
        entry.flags.push(...dups.map((r) => ({
          kind: 'duplicate', page: r.page, segment: 'Duplicated region', region: r.copy, source: r.source,
          issue: `An area of about ${r.source.w} × ${r.source.h} px appears twice on the page (pixel correlation ${r.correlation}).`,
          detail: 'Could be a copy-paste edit — or a legitimately repeated logo, stamp, letterhead or form element.',
        })));
      }
      const md = metadataConsistency(d.meta);
      entry.checks.push({ check: 'Metadata consistency', ...md });
      if (md.ok) { entry.screened = true; entry.flags.push(...md.flags.map((f) => ({ ...f, kind: 'metadata', segment: 'Document metadata' }))); }
      entry.summary = entry.screened
        ? `${entry.checks.filter((c) => c.ok).map((c) => c.check).join(', ')} screened; ${entry.flags.length} item${entry.flags.length === 1 ? '' : 's'} flagged.`
        : 'Not enough text, handwriting or pages for internal consistency screening.';
      out.push(entry);
    }
    return { documents: out };
  });

  const fusion = fuseEvidence(results, session.docs, selected, calibration.fusion);
  const report = {
    id: secureId(8),
    createdAt: new Date().toISOString(),
    app: { name: APP.title, version: APP.version, author: APP.author },
    calibration: calibration.source,
    selected,
    documents: docs.map((d) => ({
      id: d.id, name: d.displayName, kind: d.kind, size: d.size, pages: d.pageCount, role: d.role, contentType: d.contentType,
      detectedType: d.detectedType, words: wordsOf(d), ocrConfidence: d.extraction?.ocrConfidence ?? null,
      textCorrected: Boolean(d.text?.corrected), engines: d.extraction?.engine || [], warnings: d.warnings || [],
      preprocessing: (d.visual || []).filter(Boolean).map((v) => ({ page: v.page, operations: v.operations, quality: v.quality, skewDeg: v.skewDeg, orientation: v.orientation.orientation })),
      handwritingCues: bestVisual(d)?.handwriting?.handwritingCues || null,
    })),
    results,
    fusion,
    disclaimer: APP.disclaimer,
    durationMs: Math.round(performance.now() - started),
  };
  session.report = report;
  session.history = [report, ...session.history.filter((r) => r.id !== report.id)].slice(0, 5);
  changed('report');
  return report;
}
