/**
 * MODULE 2 — OCR and Text Extraction (browser only).
 *
 *  - Digital PDFs: text layer via PDF.js (scripting disabled, no font-face loading,
 *    no network). Pages without a text layer are rendered and OCR'd.
 *  - Images: decoded only after header validation, downscaled, then OCR'd.
 *  - DOCX: parsed with the defensive ZIP reader; XML with DOCTYPE/ENTITY declarations
 *    is refused (no entity expansion); embedded objects and external links are ignored.
 *  - TXT: strict UTF-8/UTF-16 decoding.
 *
 * OCR uses Tesseract (LSTM, English) compiled to WebAssembly and served from this
 * site. Language data is loaded from /vendor and never cached in IndexedDB
 * (cacheMethod: 'none'), so nothing persists after the tab closes.
 *
 * Handwriting OCR: Tesseract is trained for print. On handwriting its output is
 * often poor; S-Way reports confidence and warns instead of trusting it.
 */
import { UPLOAD_LIMITS, RENDER_LIMITS, TIMEOUTS, ARCHIVE_LIMITS } from '../config.js';
import { readZipDirectory, extractEntry } from '../security/zip-reader.js';
import { cleanExtractedText } from '../security/sanitize.js';
import { withTimeout, yieldToUi } from '../security/resource-limits.js';
import { createObjectUrl } from '../security/blob-registry.js';
import { rgbaToGray, findPaperQuad, rectifyPaper } from './imaging.js';

const assetUrl = (p) => new URL(p, document.baseURI).href;

export class ExtractionError extends Error {
  constructor(message, status = 'rejected_malformed_document') {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- PDF.js
let pdfjsPromise;
async function pdfjs() {
  pdfjsPromise ??= import('../../vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = assetUrl('vendor/pdfjs/pdf.worker.min.mjs');
    return lib;
  });
  return pdfjsPromise;
}

const PDF_OPTIONS = () => ({
  enableScripting: false, // never run document JavaScript
  enableXfa: false,
  disableFontFace: true, // render glyphs as paths; untrusted font programs never reach the browser font engine
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  useSystemFonts: false,
  isOffscreenCanvasSupported: false,
  verbosity: 0,
  standardFontDataUrl: assetUrl('vendor/pdfjs/standard_fonts/'),
  cMapUrl: assetUrl('vendor/pdfjs/cmaps/'),
  cMapPacked: true,
  wasmUrl: assetUrl('vendor/pdfjs/wasm/'),
  maxImageSize: RENDER_LIMITS.maxWorkingSide * RENDER_LIMITS.maxWorkingSide * 4,
  canvasMaxAreaInBytes: 64 * 1024 * 1024,
});

/** Build page text from PDF.js text items, inserting line breaks where the baseline changes. */
function pdfItemsToText(items) {
  let out = '';
  let lastY = null;
  let lastX = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform[5];
    const x = it.transform[4];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      out += Math.abs(y - lastY) > (Math.hypot(it.transform[0], it.transform[1]) || 12) * 1.8 ? '\n\n' : '\n';
    } else if (lastX !== null && x > lastX + 1 && !out.endsWith(' ') && it.str && !it.str.startsWith(' ')) {
      out += ' ';
    }
    out += it.str;
    if (it.hasEOL) out += '\n';
    lastY = y;
    lastX = x + (it.width || 0);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function pageCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  return c;
}

/** Release a canvas' backing store immediately (memory hygiene). */
export function releaseCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

function grayCanvas(gray) {
  const c = pageCanvas(gray.width, gray.height);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function canvasToGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return rgbaToGray(id.data, canvas.width, canvas.height);
}

async function canvasPreview(canvas) {
  const s = Math.min(1, RENDER_LIMITS.previewSide / Math.max(canvas.width, canvas.height));
  const pc = pageCanvas(canvas.width * s, canvas.height * s);
  pc.getContext('2d').drawImage(canvas, 0, 0, pc.width, pc.height);
  const blob = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.85));
  releaseCanvas(pc);
  return blob ? createObjectUrl(blob) : null;
}

async function renderPdfPage(pdf, pageNo, token) {
  const page = await pdf.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(RENDER_LIMITS.maxPdfScale, RENDER_LIMITS.maxWorkingSide / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = pageCanvas(vp.width, vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: 0, intent: 'display' });
  await withTimeout(task.promise, TIMEOUTS.pdfPageRenderMs, `Rendering PDF page ${pageNo}`, { token, onAbort: () => task.cancel() });
  page.cleanup();
  return canvas;
}

// ---------------------------------------------------------------- OCR (Tesseract.js)
let tesseractLoad;
let ocrWorker = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('The OCR engine could not be loaded.'));
    document.head.append(s);
  });
}

async function getOcrWorker(onProgress) {
  tesseractLoad ??= loadScript('vendor/tesseract/tesseract.min.js');
  await tesseractLoad;
  if (ocrWorker) return ocrWorker;
  ocrWorker = await globalThis.Tesseract.createWorker('eng', 1, {
    workerPath: assetUrl('vendor/tesseract/worker.min.js'),
    corePath: assetUrl('vendor/tesseract/core'),
    langPath: assetUrl('vendor/tesseract/lang'),
    workerBlobURL: false,
    cacheMethod: 'none', // never store language data in IndexedDB
    gzip: true,
    logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
    errorHandler: () => {},
  });
  return ocrWorker;
}

/** Terminate the OCR worker (frees WebAssembly memory; used on cancel, timeout and session clear). */
export async function terminateOcr() {
  const w = ocrWorker;
  ocrWorker = null;
  if (w) { try { await w.terminate(); } catch { /* already gone */ } }
}

async function ocrCanvas(canvas, { token, onProgress, pageNo }) {
  const worker = await getOcrWorker(onProgress);
  let input = canvas;
  if (Math.max(canvas.width, canvas.height) > RENDER_LIMITS.maxOcrSide) {
    const s = RENDER_LIMITS.maxOcrSide / Math.max(canvas.width, canvas.height);
    input = pageCanvas(canvas.width * s, canvas.height * s);
    input.getContext('2d').drawImage(canvas, 0, 0, input.width, input.height);
  }
  try {
    const { data } = await withTimeout(worker.recognize(input, {}, { text: true, blocks: true }), TIMEOUTS.ocrPageMs, `OCR of page ${pageNo}`, {
      token,
      onAbort: () => { terminateOcr(); },
    });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
      words.push({ text: w.text, confidence: Math.round(w.confidence), bbox: w.bbox });
    }
    return { text: data.text || '', confidence: Math.round(data.confidence ?? 0), words: words.slice(0, 5000), scale: input.width / canvas.width };
  } finally {
    if (input !== canvas) releaseCanvas(input);
  }
}

// ---------------------------------------------------------------- DOCX
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function safeXml(bytes, label) {
  if (bytes.length > ARCHIVE_LIMITS.maxXmlBytesParsed) throw new ExtractionError(`${label} is too large to parse safely.`, 'rejected_resource_limit_exceeded');
  const xml = new TextDecoder('utf-8').decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ExtractionError(`${label} contains DTD/entity declarations, which are refused for safety.`, 'rejected_unsafe_archive');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ExtractionError(`${label} is not well-formed XML.`);
  return doc;
}

async function extractDocx(bytes) {
  const dir = readZipDirectory(bytes, { ...ARCHIVE_LIMITS, maxTotalUncompressed: UPLOAD_LIMITS.maxDocxExpandedBytes });
  const entry = dir.entries.find((e) => e.name === 'word/document.xml');
  const doc = safeXml(await extractEntry(bytes, entry), 'The document body');
  const paragraphs = [];
  const fontChars = new Map();
  const headings = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W_NS, 'p'))) {
    let text = '';
    const style = p.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttributeNS(W_NS, 'val') || '';
    for (const r of Array.from(p.getElementsByTagNameNS(W_NS, 'r'))) {
      let rt = '';
      for (const node of Array.from(r.childNodes)) {
        if (node.localName === 't') rt += node.textContent;
        else if (node.localName === 'tab') rt += '\t';
        else if (node.localName === 'br' || node.localName === 'cr') rt += '\n';
      }
      const fonts = r.getElementsByTagNameNS(W_NS, 'rFonts')[0];
      const family = fonts?.getAttributeNS(W_NS, 'ascii') || 'default';
      const sz = r.getElementsByTagNameNS(W_NS, 'sz')[0]?.getAttributeNS(W_NS, 'val');
      const key = `${family}|${sz ? Number(sz) / 2 : 0}`;
      fontChars.set(key, (fontChars.get(key) || 0) + rt.length);
      text += rt;
    }
    if (/heading|title/i.test(style) && text.trim()) headings.push(text.trim());
    paragraphs.push(text);
  }
  const meta = {};
  const core = dir.entries.find((e) => e.name === 'docProps/core.xml');
  if (core && core.size < 1048576) {
    try {
      const cdoc = safeXml(await extractEntry(bytes, core), 'Document properties');
      const get = (tag) => Array.from(cdoc.getElementsByTagName('*')).find((n) => n.localName === tag)?.textContent?.trim();
      const toPdfDate = (iso) => (iso ? `D:${iso.replace(/[-:TZ]/g, '').slice(0, 14)}` : undefined);
      meta.CreationDate = toPdfDate(get('created'));
      meta.ModDate = toPdfDate(get('modified'));
      meta.Creator = get('creator') ? '(present)' : undefined; // personal names are not shown
      meta.Title = get('title');
    } catch { /* metadata is optional */ }
  }
  const text = paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n');
  const fonts = [...fontChars.entries()].map(([k, chars]) => { const [family, size] = k.split('|'); return { family, size: Number(size), chars }; });
  return { text, headings, fonts, meta };
}

// ---------------------------------------------------------------- main entry
/**
 * Extract a validated document. Mutates and returns `doc` with pages, text and metadata.
 * @param {object} doc session document (bytes, kind, contentType…)
 * @param {{token, onProgress:(msg:string, frac?:number)=>void, ocrBudget:{remaining:number}}} ctx
 */
export async function extractDocument(doc, ctx) {
  const { token, onProgress = () => {} } = ctx;
  token?.throwIfCancelled();
  doc.pages = [];
  doc.warnings = [...(doc.validation?.warnings || [])];
  doc.extraction = { engine: [], ocrConfidence: null, ocrPages: 0, operations: [] };

  if (doc.kind === 'txt') {
    const b = doc.bytes;
    let text;
    if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder('utf-16le').decode(b.subarray(2));
    else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder('utf-16be').decode(b.subarray(2));
    else text = new TextDecoder('utf-8').decode(b);
    setText(doc, text, [0]);
    doc.pageCount = 1;
    doc.extraction.engine.push('Plain-text decoder');
    doc.detectedType = 'digital';
    return doc;
  }

  if (doc.kind === 'docx') {
    onProgress(`Reading Word document structure of ${doc.displayName}`);
    const r = await withTimeout(extractDocx(doc.bytes), TIMEOUTS.textExtractionMs, 'Reading the DOCX file', { token });
    setText(doc, r.text, [0]);
    doc.headings = r.headings;
    doc.formatting = { fonts: r.fonts, pageNumbers: null, pageSize: null };
    doc.meta = r.meta;
    doc.pageCount = 1;
    doc.extraction.engine.push('DOCX XML parser');
    doc.detectedType = 'digital';
    doc.warnings.push('Headers, footers, footnotes and text boxes are not included in DOCX extraction.');
    return doc;
  }

  if (doc.kind === 'pdf') return extractPdf(doc, ctx);
  return extractImage(doc, ctx);
}

function setText(doc, text, pageStarts) {
  const clean = cleanExtractedText(text, UPLOAD_LIMITS.maxExtractedChars);
  if (clean.length < String(text).length) doc.warnings.push('The extracted text was truncated at the 2,000,000-character limit.');
  doc.text = { original: clean, corrected: null };
  doc.pageStarts = pageStarts;
}

async function extractPdf(doc, ctx) {
  const { token, onProgress = () => {}, ocrBudget } = ctx;
  const lib = await pdfjs();
  onProgress(`Opening PDF ${doc.displayName}`);
  const task = lib.getDocument({ data: doc.bytes.slice(), ...PDF_OPTIONS() });
  let pdf;
  try {
    pdf = await withTimeout(task.promise, TIMEOUTS.fileParseMs, 'Opening the PDF', { token, onAbort: () => task.destroy() });
  } catch (err) {
    if (err?.name === 'PasswordException') throw new ExtractionError('The PDF is password-protected.');
    if (err?.name === 'TimeoutError' || err?.name === 'CancelledError') throw err;
    throw new ExtractionError('The PDF is corrupted and could not be opened.');
  }
  try {
    if (pdf.numPages > UPLOAD_LIMITS.maxPdfPages) {
      throw new ExtractionError(`The PDF has ${pdf.numPages} pages; the limit is ${UPLOAD_LIMITS.maxPdfPages}.`, 'rejected_page_limit_exceeded');
    }
    doc.pageCount = pdf.numPages;
    try {
      const md = await pdf.getMetadata();
      const info = md?.info || {};
      doc.meta = { CreationDate: info.CreationDate, ModDate: info.ModDate, Producer: info.Producer, Creator: info.Creator, Title: info.Title, PDFFormatVersion: info.PDFFormatVersion };
    } catch { doc.meta = null; }

    let text = '';
    const pageStarts = [];
    const fontChars = new Map();
    let pageSize = null;
    let numbered = 0;
    let digitalPages = 0;
    const ocrConf = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      token?.throwIfCancelled();
      onProgress(`Extracting text from page ${p} of ${pdf.numPages}`, p / pdf.numPages);
      const page = await pdf.getPage(p);
      if (!pageSize) { const v = page.getViewport({ scale: 1 }); pageSize = `${Math.round(v.width)} × ${Math.round(v.height)} pt`; }
      const tc = await withTimeout(page.getTextContent(), TIMEOUTS.textExtractionMs, `Reading text on page ${p}`, { token });
      for (const it of tc.items) {
        if (!it.str) continue;
        const fam = tc.styles[it.fontName]?.fontFamily || 'unknown';
        const key = `${fam}|${Math.round(Math.hypot(it.transform[0], it.transform[1]))}`;
        fontChars.set(key, (fontChars.get(key) || 0) + it.str.length);
      }
      let pageText = pdfItemsToText(tc.items);
      const needsVisual = p <= RENDER_LIMITS.maxVisualPagesPerDoc;
      const textless = pageText.replace(/\s/g, '').length < 25;
      let canvas = null;
      if (needsVisual || textless) canvas = await renderPdfPage(pdf, p, token);
      if (textless && canvas) {
        if (ocrBudget.remaining > 0) {
          ocrBudget.remaining--;
          onProgress(`Running OCR on page ${p} (no text layer)`);
          const r = await ocrCanvas(canvas, { token, pageNo: p, onProgress: (f) => onProgress(`Running OCR on page ${p}`, f) });
          pageText = r.text;
          ocrConf.push(r.confidence);
          doc.extraction.ocrPages++;
          if (needsVisual) doc.pages[p - 1] = { ...(doc.pages[p - 1] || {}), ocrWords: r.words, ocrScale: r.scale };
        } else {
          doc.warnings.push(`Page ${p} has no text layer and was not OCR'd (OCR page budget for this analysis reached).`);
        }
      } else {
        digitalPages++;
      }
      if (/^\s*(page\s*)?\d{1,4}\s*$/im.test(pageText.split('\n').filter((l) => l.trim()).slice(-2).join('\n'))) numbered++;
      pageStarts.push(text.length);
      text += pageText + (p < pdf.numPages ? '\n\n' : '');
      if (canvas) {
        if (needsVisual) {
          const gray = await canvasToGray(canvas);
          const preview = await canvasPreview(canvas);
          doc.pages[p - 1] = { ...(doc.pages[p - 1] || {}), index: p, gray, preview, width: gray.width, height: gray.height };
        }
        releaseCanvas(canvas);
      }
      page.cleanup();
      await yieldToUi();
      if (text.length > UPLOAD_LIMITS.maxExtractedChars) {
        doc.warnings.push('Text extraction stopped at the 2,000,000-character limit.');
        break;
      }
    }
    setText(doc, text, pageStarts);
    doc.pages = doc.pages.filter(Boolean);
    doc.formatting = {
      fonts: [...fontChars.entries()].map(([k, chars]) => { const [family, size] = k.split('|'); return { family, size: Number(size), chars }; }),
      pageNumbers: pdf.numPages > 1 ? numbered / pdf.numPages >= 0.6 : null,
      pageSize,
    };
    if (digitalPages) doc.extraction.engine.push('PDF text layer (PDF.js)');
    if (ocrConf.length) {
      doc.extraction.engine.push('Tesseract OCR (LSTM, English)');
      doc.extraction.ocrConfidence = Math.round(ocrConf.reduce((a, c) => a + c, 0) / ocrConf.length);
    }
    doc.detectedType = digitalPages >= pdf.numPages / 2 ? 'digital' : 'printed';
    return doc;
  } finally {
    await task.destroy(); // destroys the document and its worker-side resources
  }
}

async function extractImage(doc, ctx) {
  const { token, onProgress = () => {}, ocrBudget } = ctx;
  onProgress(`Decoding image ${doc.displayName}`);
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[doc.kind];
  let bitmap;
  try {
    const { width, height } = doc.validation.details;
    const s = Math.min(1, RENDER_LIMITS.maxWorkingSide / Math.max(width, height));
    bitmap = await withTimeout(
      createImageBitmap(new Blob([doc.bytes], { type: mime }), { resizeWidth: Math.max(1, Math.round(width * s)), resizeHeight: Math.max(1, Math.round(height * s)), resizeQuality: 'high', imageOrientation: 'from-image' }),
      TIMEOUTS.fileParseMs, 'Decoding the image', { token },
    );
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'CancelledError') throw err;
    throw new ExtractionError('The image is malformed and could not be decoded.');
  }
  const canvas = pageCanvas(bitmap.width, bitmap.height);
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.drawImage(bitmap, 0, 0);
  bitmap.close();
  doc.pageCount = 1;
  let gray = await canvasToGray(canvas);
  const preview = await canvasPreview(canvas);
  doc.extraction.operations.push(`Decoded and normalised to ${gray.width} × ${gray.height} px`);
  // Phone photos of a page: undo the camera perspective before OCR and visual analysis.
  let ocrSource = canvas;
  if (doc.contentType !== 'signature') {
    const quad = findPaperQuad(gray);
    if (quad?.skewed) {
      const flat = rectifyPaper(gray, quad, RENDER_LIMITS.maxWorkingSide);
      if (flat) {
        gray = flat;
        ocrSource = grayCanvas(flat);
        doc.extraction.operations.push('Detected a photographed sheet and corrected its perspective before OCR');
        doc.warnings.push('This looks like a photo of a page: the perspective was corrected automatically before text extraction.');
      }
    }
  }
  const page = { index: 1, gray, preview, width: gray.width, height: gray.height };
  doc.pages = [page];

  let text = '';
  if (doc.contentType !== 'signature') {
    if (ocrBudget.remaining > 0) {
      ocrBudget.remaining--;
      onProgress(`Running OCR on ${doc.displayName}`);
      try {
        const r = await ocrCanvas(ocrSource, { token, pageNo: 1, onProgress: (f) => onProgress(`Running OCR on ${doc.displayName}`, f) });
        text = r.text;
        page.ocrWords = r.words;
        page.ocrScale = r.scale;
        doc.extraction.ocrConfidence = r.confidence;
        doc.extraction.ocrPages = 1;
        doc.extraction.engine.push('Tesseract OCR (LSTM, English)');
      } catch (err) {
        if (err?.name === 'CancelledError') throw err;
        doc.warnings.push(`OCR failed: ${err.message}. Visual analysis is still available.`);
      }
    } else {
      doc.warnings.push('OCR was skipped: the OCR page budget for this analysis was reached.');
    }
  }
  releaseCanvas(canvas);
  if (ocrSource !== canvas) releaseCanvas(ocrSource);
  setText(doc, text, [0]);
  doc.detectedType = 'image';
  return doc;
}

// ---------------------------------------------------------------- upload-time previews
/**
 * Open a validated PDF just far enough to count pages (enforcing the page limit
 * immediately) and render a small first-page thumbnail.
 */
export async function pdfPreflight(bytes) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: bytes.slice(), ...PDF_OPTIONS() });
  let pdf;
  try {
    pdf = await withTimeout(task.promise, TIMEOUTS.fileParseMs, 'Opening the PDF', { onAbort: () => task.destroy() });
  } catch (err) {
    if (err?.name === 'PasswordException') throw new ExtractionError('The PDF is password-protected.');
    if (err?.name === 'TimeoutError') throw new ExtractionError('The PDF took too long to open and was rejected.', 'rejected_resource_limit_exceeded');
    throw new ExtractionError('The PDF is corrupted and could not be opened.');
  }
  try {
    if (pdf.numPages > UPLOAD_LIMITS.maxPdfPages) {
      throw new ExtractionError(`The PDF has ${pdf.numPages} pages; the limit is ${UPLOAD_LIMITS.maxPdfPages}.`, 'rejected_page_limit_exceeded');
    }
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / Math.max(vp1.width, vp1.height) });
    const canvas = pageCanvas(vp.width, vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const r = page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: 0 });
    await withTimeout(r.promise, TIMEOUTS.pdfPageRenderMs, 'Rendering the preview', { onAbort: () => r.cancel() });
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    releaseCanvas(canvas);
    return { pages: pdf.numPages, thumb: blob ? createObjectUrl(blob) : null };
  } finally {
    await task.destroy(); // destroys the document and its worker-side resources
  }
}

/** Small preview of a validated image (dimensions already checked from the header). */
export async function imageThumb(bytes, kind, { width, height }) {
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[kind];
  const s = Math.min(1, 360 / Math.max(width, height));
  let bmp;
  try {
    bmp = await withTimeout(createImageBitmap(new Blob([bytes], { type: mime }), { resizeWidth: Math.max(1, Math.round(width * s)), resizeHeight: Math.max(1, Math.round(height * s)), imageOrientation: 'from-image' }), TIMEOUTS.fileParseMs, 'Decoding the image');
  } catch (err) {
    throw new ExtractionError('The image is malformed and could not be decoded.');
  }
  const c = pageCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  releaseCanvas(c);
  return blob ? createObjectUrl(blob) : null;
}
