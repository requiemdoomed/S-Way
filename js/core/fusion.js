/**
 * Multi-document evidence fusion (specification section 6).
 *
 * Fusion NEVER averages scores across modules and NEVER produces a probability of
 * common authorship (no model here has been calibrated for that on real data).
 * Instead it:
 *   1. records which modules ran, were skipped or failed,
 *   2. converts each module's measurements into a qualitative label using
 *      documented thresholds (models/calibration.json),
 *   3. downgrades reliability for short texts, low OCR confidence or poor images,
 *   4. surfaces conflicts between modules and alternative explanations.
 */

export const DEFAULT_FUSION_THRESHOLDS = Object.freeze({
  text: { highCoverage: 0.3, highContainment: 0.4, highSentenceRate: 0.3, modCoverage: 0.08, modContainment: 0.15, modParaphrase: 0.2, modTfidf: 0.6 },
  style: { highAgreement: 0.75, highMaxDisagreement: 0.08, modAgreement: 0.5, modMaxDisagreement: 0.2 },
  handwriting: { highMeanZ: 1.0, modMeanZ: 1.8 },
  signature: { highOverlap: 0.55, highChamfer: 3, modOverlap: 0.35, modChamfer: 6 },
  layout: { highAgreement: 0.8, modAgreement: 0.55 },
  source: { potentialCoverage: 0.1, limitedCoverage: 0.02 },
});

export const ALTERNATIVE_EXPLANATIONS = {
  text: ['Both documents quote or paraphrase the same source or assignment brief.', 'Shared standard phrasing, terminology, templates or questions.', 'Legitimate collaboration, group work or permitted reuse of one\'s own earlier work.', 'OCR errors can both hide and invent similarity.'],
  style: ['Genre, topic and assignment instructions shape style strongly.', 'Editing tools, grammar checkers and co-authors change style.', 'One person writes differently at different times and for different audiences.', 'Short texts give unstable style measurements.'],
  handwriting: ['Different pens, paper, posture and writing speed change handwriting.', 'Scan/photo quality, resolution and lighting affect every measurement.', 'People taught the same script can share features.', 'Deliberate disguise or imitation changes handwriting.'],
  signature: ['Genuine signatures naturally vary from one signing to the next.', 'Skilled imitations can be visually very close.', 'Static images contain no pressure, speed or stroke-order information.', 'Cropping, scanning and compression change the measurements.'],
  layout: ['Identical templates, assignment instructions or software defaults produce identical layouts.', 'Printing, scanning and photographing change apparent margins and spacing.'],
  source: ['Matched passages may be properly quoted and cited — check the original context.', 'Only the documents supplied in this session were searched.'],
  anomaly: ['Quotations, lists, tables and headings legitimately differ from body text.', 'Changes of topic, tiredness, a different pen or later editing produce variation.'],
};

const LABEL_ORDER = { High: 3, Moderate: 2, Low: 1 };

function textLabel(r, t) {
  const m = r.metrics;
  const cov = Math.max(m.sharedPassageCoverageA, m.sharedPassageCoverageB);
  const cont = Math.max(m.ngram5ContainmentAinB, m.ngram5ContainmentBinA);
  const basis = `Shared-passage coverage ${pct(cov)}, 5-gram containment ${pct(cont)}, near-identical sentences ${pct(m.sentenceMatchRateA)}, possible paraphrases ${pct(m.paraphraseRateA)}, TF-IDF cosine ${m.tfidfCosine.toFixed(2)}.`;
  if (m.exactDocument) return { label: 'High', basis: `The texts are identical after normalisation. ${basis}` };
  if (cov >= t.highCoverage || cont >= t.highContainment || m.sentenceMatchRateA >= t.highSentenceRate) return { label: 'High', basis };
  if (cov >= t.modCoverage || cont >= t.modContainment || m.paraphraseRateA >= t.modParaphrase || m.tfidfCosine >= t.modTfidf) return { label: 'Moderate', basis };
  return { label: 'Low', basis };
}

function styleLabel(r, t) {
  const basis = `${pct(r.agreement)} of 57 style features match, ${pct(r.disagreement)} clearly differ (standardised cosine ${r.cosineStandardized?.toFixed(2)}).`;
  if (Math.min(r.words.a, r.words.b) < 150) return { label: 'Inconclusive', basis: `Too little text (${r.words.a} and ${r.words.b} words). ${basis}` };
  if (r.agreement >= t.highAgreement && r.disagreement <= t.highMaxDisagreement) return { label: 'High', basis };
  if (r.agreement >= t.modAgreement && r.disagreement <= t.modMaxDisagreement) return { label: 'Moderate', basis };
  return { label: 'Low', basis };
}

function handwritingLabel(r, t) {
  const d = r.distance ?? r.meanZ;
  const basis = `Combined handwriting distance ${d} (mean standardised feature difference ${r.meanZ}${r.hingeSimilarity != null ? `, edge-hinge similarity ${r.hingeSimilarity.toFixed(2)}` : ''}); ${pct(r.agreement)} of 14 features similar; stroke-direction similarity ${r.orientationSimilarity.toFixed(2)}.`;
  if (!r.reliable) return { label: 'Inconclusive', basis: `Not enough handwriting was segmented for a stable comparison. ${basis}` };
  if (d <= t.highMeanZ) return { label: 'High', basis };
  if (d <= t.modMeanZ) return { label: 'Moderate', basis };
  return { label: 'Low', basis };
}

function signatureLabel(r, t) {
  const m = r.metrics;
  const basis = `Tolerant overlap ${m.tolerantOverlap.toFixed(2)}, mean stroke distance ${m.chamferDistancePx}px, SSIM ${m.ssim.toFixed(2)}.`;
  if (m.tolerantOverlap >= t.highOverlap && m.chamferDistancePx <= t.highChamfer) return { label: 'High', basis };
  if (m.tolerantOverlap >= t.modOverlap || m.chamferDistancePx <= t.modChamfer) return { label: 'Moderate', basis };
  return { label: 'Low', basis };
}

function layoutLabel(r, t) {
  const basis = `${pct(r.agreement)} of layout measurements similar.`;
  if (r.agreement >= t.highAgreement) return { label: 'High', basis };
  if (r.agreement >= t.modAgreement) return { label: 'Moderate', basis };
  return { label: 'Low', basis };
}

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');

/**
 * @param {object} results module outputs keyed by module id
 * @param {Map<string,object>} docs session documents
 * @param {string[]} selected module ids requested
 */
export function fuseEvidence(results, docs, selected, thresholds = DEFAULT_FUSION_THRESHOLDS) {
  const name = (id) => docs.get(id)?.displayName || 'Unknown document';
  const rows = [];
  const notes = [];
  const reliabilityOf = (ids) => {
    const reasons = [];
    for (const id of ids) {
      const d = docs.get(id);
      if (!d) continue;
      const conf = d.extraction?.ocrConfidence;
      if (Number.isFinite(conf) && conf < 70 && !d.text?.corrected) reasons.push(`${name(id)}: OCR confidence ${conf}% — review or correct the extracted text.`);
      if (d.detectedType === 'image' && d.contentType === 'handwritten' && !d.text?.corrected) reasons.push(`${name(id)}: text was machine-read from handwriting and is likely inaccurate.`);
    }
    return reasons;
  };

  for (const r of results.text?.pairs || []) {
    if (r.status === 'insufficient') { rows.push(row('text', r.pair, 'Inconclusive', r.warnings.join(' '), ['No readable text'], name)); continue; }
    const { label, basis } = textLabel(r, thresholds.text);
    const reasons = [...r.warnings, ...reliabilityOf(r.pair)];
    rows.push(row('text', r.pair, label, basis, reasons, name));
  }
  for (const r of results.style?.pairs || []) {
    if (r.status === 'insufficient') { rows.push(row('style', r.pair, 'Inconclusive', r.warnings.join(' '), [], name)); continue; }
    const { label, basis } = styleLabel(r, thresholds.style);
    rows.push(row('style', r.pair, label, basis, [...r.warnings, ...reliabilityOf(r.pair)], name));
  }
  for (const r of results.handwriting?.pairs || []) {
    const { label, basis } = handwritingLabel(r, thresholds.handwriting);
    rows.push(row('handwriting', r.pair, label, basis, r.warnings, name));
  }
  for (const r of results.signature?.pairs || []) {
    const { label, basis } = signatureLabel(r, thresholds.signature);
    rows.push(row('signature', r.pair, label, `${basis} Visual comparison only — no pressure, speed or stroke-order information.`, r.warnings, name));
  }
  for (const r of results.layout?.pairs || []) {
    const { label, basis } = layoutLabel(r, thresholds.layout);
    rows.push(row('layout', r.pair, label, `${basis} Identical templates produce identical layouts.`, [], name));
  }
  for (const r of results.source?.results || []) {
    const top = r.sources[0];
    let label = 'No match found';
    if (r.combinedCoverage >= thresholds.source.potentialCoverage) label = 'Potential match';
    else if (r.combinedCoverage >= thresholds.source.limitedCoverage || (top && top.matchCount > 0)) label = 'Limited overlap';
    const basis = top ? `${pct(r.combinedCoverage)} of the examined text is covered by matching passages; strongest source: ${top.sourceName} (${top.matchCount} match${top.matchCount === 1 ? '' : 'es'}).` : 'No source documents were available to compare against.';
    rows.push(row('source', [r.examinedId, top?.sourceId].filter(Boolean), label, basis, reliabilityOf([r.examinedId]), name));
  }
  for (const d of results.anomaly?.documents || []) {
    const total = d.flags.length;
    const label = d.screened ? (total ? `${total} region${total === 1 ? '' : 's'} to review` : 'No anomalies flagged') : 'Not enough material';
    rows.push(row('anomaly', [d.docId], label, d.summary, [], name));
  }

  // Modules that were requested but produced nothing.
  const status = {};
  for (const m of selected) {
    const r = results[m];
    status[m] = r?.error ? { state: 'failed', message: r.error } : r?.skipped ? { state: 'skipped', message: r.skipped } : r ? { state: 'completed' } : { state: 'not run', message: 'Not applicable to the uploaded documents.' };
  }

  // Conflicts: same pair, strongly different conclusions between modules.
  const byPair = new Map();
  for (const r of rows) {
    if (r.pair.length !== 2 || !LABEL_ORDER[r.label]) continue;
    const key = [...r.pair].sort().join('|');
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r);
  }
  const conflicts = [];
  for (const list of byPair.values()) {
    const high = list.filter((r) => r.label === 'High');
    const low = list.filter((r) => r.label === 'Low');
    for (const hRow of high) {
      for (const lRow of low) {
        conflicts.push({
          pair: hRow.pair,
          pairNames: hRow.pairNames,
          description: `${MODULE_NAMES[hRow.module]} is high but ${MODULE_NAMES[lRow.module].toLowerCase()} is low.`,
          interpretation: conflictText(hRow.module, lRow.module),
        });
      }
    }
  }

  const highRows = rows.filter((r) => r.label === 'High' || r.label === 'Potential match' || /to review$/.test(r.label));
  if (!rows.length) notes.push('No module produced a comparable result for these documents. Check the module availability notes.');
  const summary = buildSummary(rows, highRows, conflicts);

  return { rows, status, conflicts, summary, notes, alternatives: ALTERNATIVE_EXPLANATIONS };
}

export const MODULE_NAMES = {
  text: 'Text similarity', style: 'Writing-style similarity', handwriting: 'Handwriting-feature similarity',
  signature: 'Signature visual similarity', source: 'Source match', layout: 'Layout similarity', anomaly: 'Anomaly screening',
};

function row(module, pair, label, basis, reasons, name) {
  const unique = [...new Set(reasons.filter(Boolean))];
  return {
    module,
    moduleName: MODULE_NAMES[module],
    pair,
    pairNames: pair.map(name),
    label,
    basis,
    reliability: label === 'Inconclusive' ? 'insufficient' : unique.length ? 'reduced' : 'normal',
    reliabilityNotes: unique,
  };
}

function conflictText(hi, lo) {
  if (hi === 'text' && lo === 'style') return 'Closely matching content written in a different style can arise when text is copied or adapted from another writer, when both documents draw on the same source, or when one text was heavily edited.';
  if (hi === 'style' && lo === 'text') return 'A similar style with different content is common among writers with similar training, genre or instructions; it does not indicate shared authorship by itself.';
  if (hi === 'layout') return 'Matching layout with differing content or style usually reflects a shared template or instructions.';
  if (hi === 'handwriting' || lo === 'handwriting') return 'Handwriting features and text content measure different things; disagreement between them is common and needs expert review.';
  return 'These modules measure different properties; disagreement is expected in many legitimate situations and should be reviewed by a person.';
}

function buildSummary(rows, highRows, conflicts) {
  const lines = [];
  if (!rows.length) return ['No comparable evidence was produced.'];
  const byModule = {};
  for (const r of rows) (byModule[r.module] ||= []).push(r);
  for (const [m, list] of Object.entries(byModule)) {
    const counts = {};
    for (const r of list) counts[r.label] = (counts[r.label] || 0) + 1;
    const parts = Object.entries(counts).map(([l, c]) => `${l.toLowerCase()} for ${c} ${m === 'anomaly' || m === 'source' ? 'document' : 'pair'}${c === 1 ? '' : 's'}`);
    lines.push(`${MODULE_NAMES[m]}: ${parts.join(', ')}.`);
  }
  if (highRows.length) lines.push(`${highRows.length} finding${highRows.length === 1 ? '' : 's'} should be reviewed by a person before any conclusion is drawn.`);
  if (conflicts.length) lines.push(`${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} between modules ${conflicts.length === 1 ? 'was' : 'were'} found; see "Conflicting evidence".`);
  return lines;
}
