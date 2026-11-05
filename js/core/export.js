/**
 * Report exports and the evidence-details builder.
 * Exports are generated in memory and handed straight to the browser as downloads.
 */
import { effectiveText } from './state.js';
import { MODULE_NAMES, ALTERNATIVE_EXPLANATIONS } from './fusion.js';

/** Remove large binary payloads (images, masks, difference maps) from a report copy. */
export function exportableReport(report) {
  return JSON.parse(JSON.stringify(report, (key, value) => {
    if (['diffMap', 'imageA', 'imageB', 'mask', 'gray', 'distance'].includes(key)) return undefined;
    if (ArrayBuffer.isView(value)) return undefined;
    return value;
  }));
}

/** CSV cell escaping, including spreadsheet formula-injection protection. */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function featureCsv(report) {
  const name = (id) => report.documents.find((d) => d.id === id)?.name || id;
  const rows = [['module', 'document_a', 'document_b', 'feature', 'description', 'value_a', 'value_b', 'standardised_difference', 'reading']];
  for (const p of report.results.style?.pairs || []) {
    for (const f of p.features || []) rows.push(['writing style', name(p.pair[0]), name(p.pair[1]), f.name, f.label, f.a, f.b, f.z, f.verdict]);
  }
  for (const p of report.results.handwriting?.pairs || []) {
    for (const f of p.features) rows.push(['handwriting', name(p.pair[0]), name(p.pair[1]), f.name, f.label, f.a, f.b, f.z, f.verdict]);
  }
  for (const p of report.results.layout?.pairs || []) {
    for (const f of p.features) rows.push(['layout', name(p.pair[0]), name(p.pair[1]), f.name, f.label, f.a, f.b, f.z, f.verdict]);
  }
  for (const p of report.results.text?.pairs || []) {
    for (const [k, v] of Object.entries(p.metrics || {})) rows.push(['text', name(p.pair[0]), name(p.pair[1]), k, '', v, '', '', '']);
  }
  for (const p of report.results.signature?.pairs || []) {
    for (const [k, v] of Object.entries(p.metrics || {})) rows.push(['signature', name(p.pair[0]), name(p.pair[1]), k, '', v, '', '', '']);
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const excerptOf = (docs, id, start, end, max = 400) => {
  const d = docs.get(id);
  const t = d ? effectiveText(d) : '';
  const s = t.slice(start, end);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * Evidence details: one entry per finding with identifier, document reference,
 * page, region or text, method, raw measurement, interpretation and limitations.
 */
export function buildFindings(report, docs) {
  const out = [];
  const name = (id) => report.documents.find((d) => d.id === id)?.name || 'Unknown';
  let n = 0;
  const add = (f) => out.push({ id: `F-${String(++n).padStart(3, '0')}`, ...f });
  const pageOf = (id, offset) => {
    const d = docs.get(id);
    const starts = d?.pageStarts || [0];
    let p = 0;
    for (let i = 0; i < starts.length; i++) if (offset >= starts[i]) p = i;
    return p + 1;
  };

  for (const p of report.results.text?.pairs || []) {
    if (!p.passages) continue;
    for (const ps of p.passages.slice(0, 12)) {
      add({
        module: 'text', documents: [name(p.pair[0]), name(p.pair[1])],
        location: `page ${pageOf(p.pair[0], ps.a.start)} ↔ page ${pageOf(p.pair[1], ps.b.start)}`,
        excerpt: excerptOf(docs, p.pair[0], ps.a.start, ps.a.end),
        method: 'Exact shared word sequence (≥ 8 words)',
        measurement: `${ps.words} identical consecutive words`,
        interpretation: 'The same wording appears in both documents.',
        limitations: 'Quotations, shared sources, templates and common phrases also produce identical wording.',
      });
    }
    for (const m of (p.review || []).slice(0, 12)) {
      add({
        module: 'text', documents: [name(p.pair[0]), name(p.pair[1])],
        location: `page ${pageOf(p.pair[0], m.a.start)}, paragraph ${m.a.paragraph + 1} ↔ page ${pageOf(p.pair[1], m.b.start)}, paragraph ${m.b.paragraph + 1}`,
        excerpt: `${excerptOf(docs, p.pair[0], m.a.start, m.a.end, 260)}\n— compared with —\n${excerptOf(docs, p.pair[1], m.b.start, m.b.end, 260)}`,
        method: m.category === 'near_identical' ? 'Character-trigram cosine (near-identical sentence)' : 'Character-trigram cosine and content-word overlap (possible paraphrase)',
        measurement: `character similarity ${m.charScore.toFixed(2)}, content-word overlap ${m.wordScore.toFixed(2)}`,
        interpretation: m.reason,
        limitations: 'Lexical similarity; it cannot tell paraphrase from independent writing on the same topic.',
      });
    }
  }
  for (const p of report.results.style?.pairs || []) {
    if (!p.features) continue;
    add({
      module: 'style', documents: [name(p.pair[0]), name(p.pair[1])], location: 'whole documents',
      excerpt: `Closest features: ${p.strongestMatches.map((f) => f.label).join('; ')}. Largest differences: ${p.strongestDifferences.map((f) => f.label).join('; ')}.`,
      method: 'Chunk-based standardised comparison of 57 stylometric features',
      measurement: `agreement ${p.agreement}, disagreement ${p.disagreement}, standardised cosine ${p.cosineStandardized}`,
      interpretation: 'Describes how alike the measurable writing habits are.',
      limitations: ALTERNATIVE_EXPLANATIONS.style.join(' '),
    });
  }
  for (const p of report.results.handwriting?.pairs || []) {
    add({
      module: 'handwriting', documents: [name(p.pair[0]), name(p.pair[1])], location: `page ${p.pages[0]} ↔ page ${p.pages[1]}`,
      excerpt: p.features.map((f) => `${f.label}: ${f.a} vs ${f.b} (${f.verdict})`).join('; '),
      method: 'Handwriting feature extraction (OpenCV-style pipeline in the browser) and standardised comparison',
      measurement: `mean standardised difference ${p.meanZ}; stroke-direction similarity ${p.orientationSimilarity}`,
      interpretation: 'Describes how alike the measured handwriting features are.',
      limitations: ALTERNATIVE_EXPLANATIONS.handwriting.join(' '),
    });
  }
  for (const p of report.results.signature?.pairs || []) {
    add({
      module: 'signature', documents: [name(p.pair[0]), name(p.pair[1])], location: `regions: ${p.regions.map((r) => (typeof r === 'string' ? r : `${r.w}×${r.h}px at (${r.x}, ${r.y})`)).join(' ↔ ')}`,
      excerpt: p.missingOrExtra.map((x) => `${x.where}: ${x.position}`).join('; ') || 'No large region present in only one signature.',
      method: 'Normalisation, alignment, tolerant overlap, chamfer distance, SSIM, Hu moments',
      measurement: `overlap ${p.metrics.tolerantOverlap}, chamfer ${p.metrics.chamferDistancePx}px, SSIM ${p.metrics.ssim}`,
      interpretation: 'Visual likeness of the two signature images.',
      limitations: ALTERNATIVE_EXPLANATIONS.signature.join(' '),
    });
  }
  for (const res of report.results.source?.results || []) {
    for (const s of res.sources) {
      for (const m of s.matches.slice(0, 8)) {
        add({
          module: 'source', documents: [res.examinedName, s.sourceName], location: `examined page ${m.examined.page} → source page ${m.source.page}`,
          excerpt: excerptOf(docs, res.examinedId, m.examined.start, m.examined.end),
          method: m.method, measurement: `score ${m.score.toFixed(2)}`,
          interpretation: 'This passage matches the source document.',
          limitations: ALTERNATIVE_EXPLANATIONS.source.join(' '),
        });
      }
    }
  }
  for (const p of report.results.layout?.pairs || []) {
    add({
      module: 'layout', documents: [name(p.pair[0]), name(p.pair[1])], location: `page ${p.pages[0]} ↔ page ${p.pages[1]}`,
      excerpt: p.features.map((f) => `${f.label}: ${f.a} vs ${f.b}`).join('; '),
      method: 'Page segmentation and layout measurements', measurement: `${Math.round(p.agreement * 100)}% of measurements similar`,
      interpretation: 'Describes how alike the page layouts are.', limitations: ALTERNATIVE_EXPLANATIONS.layout.join(' '),
    });
  }
  for (const d of report.results.anomaly?.documents || []) {
    for (const f of d.flags) {
      add({
        module: 'anomaly', documents: [name(d.docId)], location: f.page ? `page ${f.page}, ${f.segment || ''}` : f.segment || 'document',
        excerpt: f.excerpt || f.issue || (f.region ? `Region y ${f.region.y0}–${f.region.y1} px` : ''),
        method: f.kind === 'metadata' ? 'Metadata date consistency' : f.kind === 'duplicate' ? 'Block-matching copy-move detection with pixel-correlation verification' : 'Robust z-scores (median/MAD) with Isolation Forest',
        measurement: f.features ? f.features.map((x) => `${x.description}: z ${x.robustZ}`).join('; ') : f.detail || '',
        interpretation: 'This part behaves differently from the rest of the document.',
        limitations: ALTERNATIVE_EXPLANATIONS.anomaly.join(' '),
      });
    }
  }
  return out;
}

export const moduleName = (m) => MODULE_NAMES[m] || m;
