/** Rendering helpers: highlighted text (textContent only) and canvas overlays. */
import { h } from '../dom.js';

/**
 * Render text with highlighted ranges as <mark> elements. Overlapping ranges are
 * resolved in priority order (earlier in the list wins). Untrusted text is only
 * ever inserted as text nodes.
 * @param {string} text
 * @param {{start:number,end:number,cls:string,id?:string,title?:string}[]} ranges
 */
export function highlightedText(text, ranges, onMarkClick) {
  const placed = [];
  for (const r of ranges) {
    if (!(r.end > r.start)) continue;
    if (placed.some((p) => r.start < p.end && r.end > p.start)) continue;
    placed.push(r);
  }
  placed.sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const r of placed) {
    if (r.start > pos) frag.append(document.createTextNode(text.slice(pos, r.start)));
    const mark = h('mark', { class: r.cls, title: r.title || null, tabindex: r.id ? '0' : null, dataset: r.id ? { match: r.id } : undefined }, text.slice(r.start, r.end));
    if (onMarkClick && r.id) {
      mark.addEventListener('click', () => onMarkClick(r.id, mark));
      mark.addEventListener('keydown', (e) => { if (e.key === 'Enter') onMarkClick(r.id, mark); });
    }
    frag.append(mark);
    pos = r.end;
  }
  if (pos < text.length) frag.append(document.createTextNode(text.slice(pos)));
  return frag;
}

export function grayToCanvas(gray, canvas = document.createElement('canvas')) {
  canvas.width = gray.width;
  canvas.height = gray.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const INK_A = [74, 52, 38];   // walnut
const INK_B = [139, 46, 36];  // ribbon red
const BOTH = [20, 14, 10];

/**
 * Overlay two page masks aligned at the top-left of their text blocks.
 * A-only ink = walnut, B-only = ribbon red (drawn with a stipple), overlap = near black.
 * mode: 'both' | 'a' | 'b'
 */
export function maskOverlay(canvas, va, vb, mode = 'both') {
  const ax = va.textBlock?.x0 || 0; const ay = va.textBlock?.y0 || 0;
  const bx = vb.textBlock?.x0 || 0; const by = vb.textBlock?.y0 || 0;
  const w = Math.max(va.width - ax, vb.width - bx);
  const hgt = Math.max(va.height - ay, vb.height - by);
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  let onlyA = 0; let onlyB = 0; let both = 0;
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const sa = y + ay < va.height && x + ax < va.width ? va.mask[(y + ay) * va.width + x + ax] : 0;
      const sb = y + by < vb.height && x + bx < vb.width ? vb.mask[(y + by) * vb.width + x + bx] : 0;
      let c = [250, 246, 236];
      if (sa && sb) { c = BOTH; both++; }
      else if (sa) { onlyA++; if (mode !== 'b') c = INK_A; }
      else if (sb) { onlyB++; if (mode !== 'a' && (x + y) % 3 !== 0) c = INK_B; }
      if (sa && sb && mode === 'a') c = INK_A;
      if (sa && sb && mode === 'b') c = INK_B;
      const i = (y * w + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const total = onlyA + onlyB + both || 1;
  return { onlyA: onlyA / total, onlyB: onlyB / total, both: both / total };
}

/** Signature difference map: 1 = first only, 2 = second only, 3 = both. */
export function signatureDiff(canvas, diff, w, hgt, mode = 'both') {
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  for (let i = 0; i < diff.length; i++) {
    const x = i % w; const y = (i - x) / w;
    let c = [250, 246, 236];
    const d = diff[i];
    if (d === 3) c = mode === 'a' ? INK_A : mode === 'b' ? INK_B : BOTH;
    else if (d === 1 && mode !== 'b') c = INK_A;
    else if (d === 2 && mode !== 'a' && (x + y) % 3 !== 0) c = INK_B;
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw a page with detected text-line boxes (handwriting lab). */
export function linesOverlay(canvas, gray, lines, flagged = []) {
  grayToCanvas(gray, canvas);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = Math.max(2, gray.width / 600);
  lines.forEach((l, i) => {
    const isFlag = flagged.includes(i);
    ctx.strokeStyle = isFlag ? 'rgba(139,46,36,.95)' : 'rgba(154,123,63,.85)';
    ctx.setLineDash(isFlag ? [] : [8, 5]);
    ctx.strokeRect(l.x0 - 2, l.y0 - 2, l.x1 - l.x0 + 4, l.y1 - l.y0 + 4);
    ctx.fillStyle = isFlag ? 'rgba(139,46,36,.95)' : 'rgba(74,52,38,.9)';
    ctx.font = `${Math.max(14, gray.width / 70)}px Courier Prime, monospace`;
    ctx.fillText(String(i + 1), Math.max(2, l.x0 - 30), l.y0 + (l.y1 - l.y0) / 2);
  });
}

/** Legend element shared by overlays (patterns + words, not colour alone). */
export function overlayLegend(nameA, nameB) {
  return h('ul', { class: 'legend' },
    h('li', {}, h('span', { class: 'swatch sw-a', 'aria-hidden': 'true' }), `Solid brown: ink only in ${nameA}`),
    h('li', {}, h('span', { class: 'swatch sw-b', 'aria-hidden': 'true' }), `Stippled red: ink only in ${nameB}`),
    h('li', {}, h('span', { class: 'swatch sw-both', 'aria-hidden': 'true' }), 'Black: ink in both'));
}

export function canvasToPngDownload(canvas, filename, download) {
  canvas.toBlob((b) => { if (b) download(b, filename); }, 'image/png');
}

/**
 * Show duplicated regions on a page drawn from its ink mask (working-copy coordinates):
 * source region dashed brown, copy solid red, joined by a line.
 */
export function duplicateFigure(canvas, visual, regions) {
  const { width: w, height: hgt, mask } = visual;
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 40 : 248;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v - (mask[i] ? 0 : 4); img.data[i * 4 + 2] = v - (mask[i] ? 0 : 12); img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = Math.max(3, w / 300);
  regions.forEach((r, i) => {
    ctx.setLineDash([12, 6]);
    ctx.strokeStyle = 'rgba(154,123,63,.95)';
    ctx.strokeRect(r.source.x, r.source.y, r.source.w, r.source.h);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(139,46,36,.95)';
    ctx.strokeRect(r.copy.x, r.copy.y, r.copy.w, r.copy.h);
    ctx.beginPath();
    ctx.moveTo(r.source.x + r.source.w / 2, r.source.y + r.source.h / 2);
    ctx.lineTo(r.copy.x + r.copy.w / 2, r.copy.y + r.copy.h / 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139,46,36,.95)';
    ctx.font = `${Math.max(18, w / 45)}px Courier Prime, monospace`;
    ctx.fillText(`#${i + 1}`, r.copy.x, Math.max(20, r.copy.y - 8));
  });
}
