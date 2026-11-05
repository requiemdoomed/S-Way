/**
 * Analysis Web Worker. All CPU-heavy analysis runs here so the page never freezes,
 * and so a stuck or oversized computation can be stopped by terminating the worker
 * (real cancellation, not just ignoring a result). The worker has no network code
 * and no access to the DOM, cookies or storage.
 */
import { preprocessPage } from '../engines/preprocess.js';
import { extractHandwritingFeatures, compareHandwriting } from '../engines/handwriting.js';
import { extractLayout, compareLayout } from '../engines/layout.js';
import { normalizeSignature, compareSignatures, suggestSignatureRegion } from '../engines/signature.js';
import { compareTexts } from '../engines/text-similarity.js';
import { compareStyle, clusterByStyle } from '../engines/stylometry.js';
import { investigateSources } from '../engines/source-matching.js';
import { textConsistency, handwritingConsistency, layoutConsistency } from '../engines/anomaly.js';
import { crop } from '../engines/imaging.js';
import { detectDuplicatedRegions } from '../engines/tamper.js';
import { median } from '../engines/text-utils.js';

const handlers = {
  visualProfile({ gray, wantHandwriting }) {
    const pre = preprocessPage(gray);
    const hw = wantHandwriting ? extractHandwritingFeatures(pre) : null;
    const layout = extractLayout(pre);
    const suggestion = suggestSignatureRegion(pre);
    const duplicates = detectDuplicatedRegions(pre.image, { lineHeight: pre.lines.length ? median(pre.lines.map((l) => l.height)) : 0 });
    return {
      result: {
        width: pre.width,
        height: pre.height,
        lines: pre.lines,
        textBlock: pre.textBlock,
        skewDeg: pre.skewDeg,
        orientation: pre.orientation,
        boundary: pre.boundary,
        resolution: pre.resolution,
        quality: pre.quality,
        operations: pre.operations,
        handwriting: hw,
        layout,
        signatureSuggestion: suggestion,
        duplicates: { regions: duplicates.regions, analysed: duplicates.analysed },
        mask: pre.mask,
      },
      transfer: [pre.mask.buffer],
    };
  },
  text: ({ a, b, thresholds }) => ({ result: compareTexts(a, b, thresholds) }),
  style: ({ a, b }) => ({ result: compareStyle(a, b) }),
  cluster: ({ docs }) => ({ result: clusterByStyle(docs) }),
  handwritingCompare: ({ fa, fb, scales }) => ({ result: compareHandwriting(fa, fb, scales) }),
  layoutCompare: ({ la, lb }) => ({ result: compareLayout(la, lb) }),
  signature({ a, b, regionA, regionB }) {
    const ca = regionA ? crop(a, regionA.x, regionA.y, regionA.w, regionA.h) : a;
    const cb = regionB ? crop(b, regionB.x, regionB.y, regionB.w, regionB.h) : b;
    const na = normalizeSignature(ca);
    const nb = normalizeSignature(cb);
    if (!na.ok || !nb.ok) return { result: { ok: false, warnings: [...(na.warnings || []), ...(nb.warnings || [])] } };
    const cmp = compareSignatures(na, nb);
    return {
      result: { ok: true, ...cmp, imageA: na.image, imageB: nb.image, normA: { aspectRatio: na.aspectRatio, strokes: na.strokes }, normB: { aspectRatio: nb.aspectRatio, strokes: nb.strokes } },
    };
  },
  source: ({ examined, sources, thresholds }) => ({ result: investigateSources(examined, sources, thresholds) }),
  anomalyText: ({ text }) => ({ result: textConsistency(text) }),
  anomalyHandwriting: ({ perLine }) => ({ result: handwritingConsistency(perLine) }),
  anomalyLayout: ({ pages }) => ({ result: layoutConsistency(pages) }),
};

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  const fn = handlers[type];
  if (!fn) { self.postMessage({ id, error: 'Unknown analysis task.' }); return; }
  try {
    const { result, transfer = [] } = fn(payload);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    // Only a short message is returned — never stack traces or document content.
    self.postMessage({ id, error: String(err?.message || 'Analysis failed').slice(0, 200) });
  }
};
