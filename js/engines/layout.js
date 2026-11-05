/**
 * MODULE 8 — Layout and Formatting Analysis.
 *
 * Visual layout (from page images): margins, line spacing, text density, alignment,
 * indentation and page utilisation. Digital formatting (from PDF text layers / DOCX
 * styles): fonts, font sizes and page numbering.
 *
 * Identical layout is common when people use the same template, assignment brief
 * or default word-processor settings — it says nothing about authorship on its own.
 */
import { median, std, mean } from './text-utils.js';
import { round } from './imaging.js';

export const LAYOUT_FEATURE_INFO = {
  marginLeft: 'Left margin (share of page width)',
  marginRight: 'Right margin (share of page width)',
  marginTop: 'Top margin (share of page height)',
  marginBottom: 'Bottom margin (share of page height)',
  lineSpacing: 'Line spacing relative to line height',
  lineHeight: 'Line height relative to page height',
  textDensity: 'Ink density inside the text area',
  pageUtilisation: 'Share of the page covered by the text area',
  leftEdgeVariation: 'Left-edge variation (0 = perfectly aligned)',
  rightEdgeVariation: 'Right-edge variation (0 = justified)',
  indentRate: 'Share of lines that are indented',
};

const SCALES = {
  marginLeft: 0.025, marginRight: 0.03, marginTop: 0.03, marginBottom: 0.04, lineSpacing: 0.25, lineHeight: 0.004,
  textDensity: 0.03, pageUtilisation: 0.06, leftEdgeVariation: 0.015, rightEdgeVariation: 0.03, indentRate: 0.08,
};

/** Visual layout features of one preprocessed page. */
export function extractLayout(pre) {
  const { lines, width: w, height: h, textBlock } = pre;
  if (!textBlock || lines.length < 2) return { ok: false, reason: 'Too little text on the page to measure layout.' };
  const left = lines.map((l) => l.x0);
  const right = lines.map((l) => l.x1);
  const medLeft = median(left);
  const spacing = lines.slice(1).map((l, i) => (l.y0 + l.y1) / 2 - (lines[i].y0 + lines[i].y1) / 2);
  const H = median(lines.map((l) => l.height));
  let ink = 0;
  let area = 0;
  for (const l of lines) { ink += l.ink; area += (l.x1 - l.x0 + 1) * l.height; }
  const blockW = textBlock.w;
  // Lines ending well short of the right edge are paragraph ends, not alignment evidence.
  const fullLines = right.filter((r) => r > textBlock.x1 - blockW * 0.15);
  const features = {
    marginLeft: textBlock.x0 / w,
    marginRight: (w - 1 - textBlock.x1) / w,
    marginTop: textBlock.y0 / h,
    marginBottom: (h - 1 - textBlock.y1) / h,
    lineSpacing: spacing.length ? median(spacing) / H : 0,
    lineHeight: H / h,
    textDensity: area ? ink / area : 0,
    pageUtilisation: (textBlock.w * textBlock.h) / (w * h),
    leftEdgeVariation: std(left.filter((x) => x < medLeft + blockW * 0.05)) / w,
    rightEdgeVariation: fullLines.length > 1 ? std(fullLines) / w : 0,
    indentRate: left.filter((x) => x > medLeft + blockW * 0.02 && x < medLeft + blockW * 0.2).length / lines.length,
  };
  return {
    ok: true,
    lines: lines.length,
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, round(v, 4)])),
    alignment: features.rightEdgeVariation < 0.006 ? 'justified' : 'ragged right',
  };
}

/** Compare two visual layouts. */
export function compareLayout(la, lb) {
  const features = Object.keys(LAYOUT_FEATURE_INFO).map((name) => {
    const a = la.features[name];
    const b = lb.features[name];
    const z = Math.abs(a - b) / SCALES[name];
    return { name, label: LAYOUT_FEATURE_INFO[name], a, b, z: round(z, 2), verdict: z < 1 ? 'similar' : z < 2 ? 'partial' : 'different' };
  });
  const similar = features.filter((f) => f.verdict === 'similar').length;
  return {
    features,
    agreement: round(similar / features.length, 4),
    alignment: [la.alignment, lb.alignment],
    meanZ: round(mean(features.map((f) => Math.min(f.z, 5))), 3),
  };
}

/** Compare digital formatting summaries ({fonts:[{family,size,chars}], pageNumbers, pageSize}). */
export function compareDigitalFormatting(fa, fb) {
  if (!fa || !fb || !fa.fonts?.length || !fb.fonts?.length) return null;
  const dist = (f) => {
    const total = f.fonts.reduce((s, x) => s + x.chars, 0) || 1;
    const m = new Map();
    for (const x of f.fonts) {
      const key = `${x.family} ${Math.round(x.size)}pt`;
      m.set(key, (m.get(key) || 0) + x.chars / total);
    }
    return m;
  };
  const da = dist(fa);
  const db = dist(fb);
  let overlap = 0;
  for (const [k, v] of da) overlap += Math.min(v, db.get(k) || 0);
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => ({ style: k, share: round(v, 3) }));
  return {
    fontStyleOverlap: round(overlap, 4),
    stylesA: top(da),
    stylesB: top(db),
    pageNumbers: [fa.pageNumbers ?? null, fb.pageNumbers ?? null],
    pageSize: [fa.pageSize ?? null, fb.pageSize ?? null],
  };
}
